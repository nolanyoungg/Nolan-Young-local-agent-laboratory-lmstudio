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

export const WriteFileInputSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export class WriteFileTool {
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
    const parsed = parseToolInput(WriteFileInputSchema, input);
    validateTextContent(parsed.content);
    const candidate = await this.#guard.resolveForWrite(parsed.path, {
      mustExist: false,
    });
    const candidateOverlay = this.#overlay.get(candidate.relativePath);
    const guarded =
      candidateOverlay === undefined
        ? await this.#guard.resolveForWrite(parsed.path, { mustExist: true })
        : candidate;
    const overlaid = this.#overlay.get(guarded.relativePath);
    const before = overlaid ?? (await readUtf8File(guarded.absolutePath)).content;
    const beforeSha256 = sha256(before);
    if (parsed.expectedSha256 !== beforeSha256) {
      throw new FilesystemToolError(
        "HASH_MISMATCH",
        `Expected SHA-256 ${parsed.expectedSha256}, but ${guarded.relativePath} is ${beforeSha256}.`,
      );
    }
    const after = preserveTextStyle(before, parsed.content);
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
