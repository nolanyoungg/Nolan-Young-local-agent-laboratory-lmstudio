import { posix } from "node:path";
import { applyPatch } from "diff";
import { z } from "zod";
import { DryRunOverlay } from "./DryRunOverlay.js";
import { FilesystemToolError } from "./errors.js";
import {
  atomicReplaceText,
  existingMode,
  parseToolInput,
  preserveTextStyle,
  readUtf8File,
  sha256,
  validateTextContent,
} from "./internal.js";
import type { FileMutationResult, ToolDependencies } from "./types.js";

export const ApplyPatchInputSchema = z
  .object({
    path: z.string().min(1),
    patch: z.string().min(1),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export class ApplyPatchTool {
  readonly #guard: ToolDependencies["workspaceGuard"];
  readonly #dryRun: boolean;
  readonly #overlay: DryRunOverlay;

  public constructor(dependencies: ToolDependencies) {
    this.#guard = dependencies.workspaceGuard;
    this.#dryRun = dependencies.dryRun ?? false;
    this.#overlay =
      dependencies.overlay instanceof DryRunOverlay ? dependencies.overlay : new DryRunOverlay();
  }

  public async execute(input: unknown): Promise<FileMutationResult> {
    const parsed = parseToolInput(ApplyPatchInputSchema, input);
    const candidate = await this.#guard.resolveForWrite(parsed.path, {
      mustExist: false,
    });
    const guarded = this.#overlay.has(candidate.relativePath)
      ? candidate
      : await this.#guard.resolveForWrite(parsed.path, { mustExist: true });
    assertSingleFilePatch(parsed.patch, guarded.relativePath);
    const overlaid = this.#overlay.get(guarded.relativePath);
    const before = overlaid ?? (await readUtf8File(guarded.absolutePath)).content;
    const beforeSha256 = sha256(before);
    if (beforeSha256 !== parsed.expectedSha256) {
      throw new FilesystemToolError(
        "HASH_MISMATCH",
        `Expected SHA-256 ${parsed.expectedSha256}, but ${guarded.relativePath} is ${beforeSha256}.`,
      );
    }

    const patched = applyPatch(before, parsed.patch);
    if (patched === false) {
      throw new FilesystemToolError(
        "PATCH_FAILED",
        `Patch did not apply cleanly to ${guarded.relativePath}.`,
      );
    }
    const after = preserveTextStyle(before, patched);
    validateTextContent(after);

    if (this.#dryRun) {
      this.#overlay.set(guarded.relativePath, after);
    } else {
      const revalidated = await this.#guard.resolveForWrite(parsed.path, {
        mustExist: true,
      });
      const current = await readUtf8File(revalidated.absolutePath);
      if (sha256(current.content) !== parsed.expectedSha256) {
        throw new FilesystemToolError(
          "HASH_MISMATCH",
          `File changed after observation: ${revalidated.relativePath}.`,
        );
      }
      const mode = await existingMode(revalidated.absolutePath);
      await atomicReplaceText(revalidated.absolutePath, after, mode);
    }

    return {
      path: guarded.relativePath,
      dryRun: this.#dryRun,
      bytes: Buffer.byteLength(after, "utf8"),
      beforeSha256,
      afterSha256: sha256(after),
    };
  }
}

function assertSingleFilePatch(patch: string, expectedPath: string): void {
  const lines = patch.split(/\r?\n/u);
  const oldHeaders = lines.filter((line) => line.startsWith("--- "));
  const newHeaders = lines.filter((line) => line.startsWith("+++ "));
  const gitHeaders = lines.filter((line) => line.startsWith("diff --git "));
  if (
    oldHeaders.length !== 1 ||
    newHeaders.length !== 1 ||
    gitHeaders.length > 1 ||
    !lines.some((line) => line.startsWith("@@ "))
  ) {
    throw new FilesystemToolError(
      "PATCH_FAILED",
      "Patch must be one unified diff for exactly one existing file.",
    );
  }

  const paths = [oldHeaders[0], newHeaders[0]].map((header) =>
    normalizePatchPath(header?.slice(4).split("\t", 1)[0] ?? ""),
  );
  const expected = posix.normalize(expectedPath.replaceAll("\\", "/"));
  if (
    paths.some(
      (path) => path === "/dev/null" || (path !== expected && stripGitPrefix(path) !== expected),
    )
  ) {
    throw new FilesystemToolError("PATCH_FAILED", `Patch headers must target ${expected}.`);
  }
}

function normalizePatchPath(path: string): string {
  return posix.normalize(path.trim().replaceAll("\\", "/"));
}

function stripGitPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}
