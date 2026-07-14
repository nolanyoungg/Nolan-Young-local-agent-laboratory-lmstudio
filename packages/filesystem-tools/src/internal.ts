import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import type { z } from "zod";
import { FilesystemToolError, asFilesystemToolError } from "./errors.js";
import { MAX_FILE_BYTES } from "./types.js";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function validateTextContent(content: string): void {
  const bytes = utf8Bytes(content);
  if (bytes > MAX_FILE_BYTES) {
    throw new FilesystemToolError(
      "FILE_TOO_LARGE",
      `Content is ${bytes} bytes; the maximum is ${MAX_FILE_BYTES} bytes.`,
    );
  }
  if (content.includes("\0")) {
    throw new FilesystemToolError("BINARY_FILE", "Text content must not contain null bytes.");
  }
}

export async function readUtf8File(absolutePath: string): Promise<{
  readonly content: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
}> {
  let metadata;
  try {
    metadata = await stat(absolutePath);
  } catch (error) {
    throw asFilesystemToolError(error, "File does not exist or cannot be inspected.");
  }
  if (!metadata.isFile()) {
    throw new FilesystemToolError("NOT_A_FILE", "Path is not a regular file.");
  }
  if (metadata.size > MAX_FILE_BYTES) {
    throw new FilesystemToolError(
      "FILE_TOO_LARGE",
      `File is ${metadata.size} bytes; the maximum is ${MAX_FILE_BYTES} bytes.`,
    );
  }

  const buffer = await readFile(absolutePath);
  if (buffer.includes(0)) {
    throw new FilesystemToolError("BINARY_FILE", "File contains null bytes.");
  }

  let content: string;
  try {
    content = utf8Decoder.decode(buffer);
  } catch (error) {
    throw new FilesystemToolError("BINARY_FILE", "File is not valid UTF-8 text.", { cause: error });
  }

  if (looksBinary(content)) {
    throw new FilesystemToolError(
      "BINARY_FILE",
      "File appears to contain binary control characters.",
    );
  }

  return {
    content,
    size: buffer.byteLength,
    mtimeMs: metadata.mtimeMs,
    mode: metadata.mode,
  };
}

export function truncateUtf8(
  value: string,
  maximumBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maximumBytes) {
    return { value, truncated: false };
  }

  let end = maximumBytes;
  while (end > 0) {
    try {
      return {
        value: utf8Decoder.decode(buffer.subarray(0, end)),
        truncated: true,
      };
    } catch {
      end -= 1;
    }
  }
  return { value: "", truncated: true };
}

export async function atomicReplaceText(
  absolutePath: string,
  content: string,
  mode?: number,
): Promise<void> {
  validateTextContent(content);
  const directory = dirname(absolutePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${randomUUID()}.local-agent-write.tmp`);
  let temporaryExists = false;

  try {
    const handle = await open(temporaryPath, "wx", mode);
    temporaryExists = true;
    try {
      await handle.writeFile(content, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, absolutePath);
    temporaryExists = false;
  } catch (error) {
    throw asFilesystemToolError(error, "Unable to write the guarded file.");
  } finally {
    if (temporaryExists) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export async function atomicCreateText(absolutePath: string, content: string): Promise<void> {
  validateTextContent(content);
  const directory = dirname(absolutePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${randomUUID()}.local-agent-create.tmp`);
  let temporaryExists = false;

  try {
    const handle = await open(temporaryPath, "wx");
    temporaryExists = true;
    try {
      await handle.writeFile(content, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, absolutePath);
    await unlink(temporaryPath).catch(() => undefined);
    temporaryExists = false;
  } catch (error) {
    throw asFilesystemToolError(error, "Unable to create the guarded file.");
  } finally {
    if (temporaryExists) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export async function existingMode(absolutePath: string): Promise<number> {
  const metadata = await lstat(absolutePath);
  if (!metadata.isFile()) {
    throw new FilesystemToolError("NOT_A_FILE", "Path is not a regular file.");
  }
  return metadata.mode;
}

export function preserveTextStyle(original: string, replacement: string): string {
  const originalHasBom = original.startsWith("\uFEFF");
  const originalBody = originalHasBom ? original.slice(1) : original;
  let replacementBody = replacement.startsWith("\uFEFF") ? replacement.slice(1) : replacement;

  const crlfCount = originalBody.match(/\r\n/gu)?.length ?? 0;
  const lfCount = originalBody.match(/(?<!\r)\n/gu)?.length ?? 0;
  if (crlfCount > lfCount) {
    replacementBody = replacementBody.replaceAll(/\r?\n/gu, "\r\n");
  } else if (lfCount > 0) {
    replacementBody = replacementBody.replaceAll("\r\n", "\n");
  }

  const originalEndsWithNewline = /\r?\n$/u.test(originalBody);
  const replacementEndsWithNewline = /\r?\n$/u.test(replacementBody);
  if (originalEndsWithNewline && replacementBody.length > 0 && !replacementEndsWithNewline) {
    replacementBody += crlfCount > lfCount ? "\r\n" : "\n";
  } else if (!originalEndsWithNewline && replacementEndsWithNewline) {
    replacementBody = replacementBody.replace(/\r?\n$/u, "");
  }

  return `${originalHasBom ? "\uFEFF" : ""}${replacementBody}`;
}

function looksBinary(content: string): boolean {
  if (content.length === 0) {
    return false;
  }

  let suspicious = 0;
  for (const character of content) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12) {
      suspicious += 1;
    }
  }
  return suspicious / content.length > 0.01;
}

export function parseToolInput<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown,
): z.output<TSchema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new FilesystemToolError(
      "INVALID_INPUT",
      `Invalid filesystem tool input: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}
