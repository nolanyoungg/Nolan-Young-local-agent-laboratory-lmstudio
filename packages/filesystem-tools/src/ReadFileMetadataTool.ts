import { lstat } from "node:fs/promises";
import { z } from "zod";
import { DryRunOverlay } from "./DryRunOverlay.js";
import { parseToolInput, sha256, utf8Bytes } from "./internal.js";
import type { ToolDependencies } from "./types.js";

export const ReadFileMetadataInputSchema = z.object({ path: z.string().min(1) }).strict();

export interface ReadFileMetadataResult {
  readonly path: string;
  readonly type: "directory" | "file";
  readonly bytes: number;
  readonly modifiedAt: string | null;
  readonly sha256: string | null;
  readonly fromDryRunOverlay: boolean;
}

export class ReadFileMetadataTool {
  readonly #guard: ToolDependencies["workspaceGuard"];
  readonly #overlay: DryRunOverlay;

  public constructor(dependencies: ToolDependencies) {
    this.#guard = dependencies.workspaceGuard;
    this.#overlay =
      dependencies.overlay instanceof DryRunOverlay ? dependencies.overlay : new DryRunOverlay();
  }

  public async execute(input: unknown): Promise<ReadFileMetadataResult> {
    const parsed = parseToolInput(ReadFileMetadataInputSchema, input);
    const guarded = await this.#guard.resolveForRead(parsed.path);
    const overlayContent = this.#overlay.get(guarded.relativePath);
    if (overlayContent !== undefined) {
      return {
        path: guarded.relativePath,
        type: "file",
        bytes: utf8Bytes(overlayContent),
        modifiedAt: null,
        sha256: sha256(overlayContent),
        fromDryRunOverlay: true,
      };
    }

    const metadata = await lstat(guarded.absolutePath);
    return {
      path: guarded.relativePath,
      type: metadata.isDirectory() ? "directory" : "file",
      bytes: metadata.size,
      modifiedAt: metadata.mtime.toISOString(),
      // Metadata inspection deliberately never opens the file. This makes it
      // safe for binary images and fonts and avoids exposing file contents.
      sha256: null,
      fromDryRunOverlay: false,
    };
  }
}
