import { lstat } from "node:fs/promises";
import { z } from "zod";
import { DryRunOverlay } from "./DryRunOverlay.js";
import { FilesystemToolError } from "./errors.js";
import { atomicCreateText, parseToolInput, sha256, validateTextContent } from "./internal.js";
import type { FileMutationResult, ToolDependencies } from "./types.js";

export const CreateFileInputSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
  })
  .strict();

export class CreateFileTool {
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
    const parsed = parseToolInput(CreateFileInputSchema, input);
    validateTextContent(parsed.content);
    const guarded = await this.#guard.resolveForWrite(parsed.path, {
      mustExist: false,
    });
    if (this.#overlay.has(guarded.relativePath) || (await pathExists(guarded.absolutePath))) {
      throw new FilesystemToolError("FILE_EXISTS", `File already exists: ${guarded.relativePath}`);
    }

    if (this.#dryRun) {
      this.#overlay.set(guarded.relativePath, parsed.content);
    } else {
      const revalidated = await this.#guard.resolveForWrite(parsed.path, {
        mustExist: false,
      });
      if (await pathExists(revalidated.absolutePath)) {
        throw new FilesystemToolError(
          "FILE_EXISTS",
          `File appeared after precondition check: ${revalidated.relativePath}`,
        );
      }
      await atomicCreateText(revalidated.absolutePath, parsed.content);
    }

    return {
      path: guarded.relativePath,
      dryRun: this.#dryRun,
      bytes: Buffer.byteLength(parsed.content, "utf8"),
      beforeSha256: null,
      afterSha256: sha256(parsed.content),
    };
  }
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await lstat(absolutePath);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
