import { z } from "zod";
import { DryRunOverlay } from "./DryRunOverlay.js";
import { parseToolInput, readUtf8File, sha256, truncateUtf8 } from "./internal.js";
import { MAX_OUTPUT_BYTES, type ToolDependencies } from "./types.js";

export const ReadFileInputSchema = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().max(MAX_OUTPUT_BYTES).default(MAX_OUTPUT_BYTES),
  })
  .strict();

export type ReadFileInput = z.input<typeof ReadFileInputSchema>;

export interface ReadFileResult {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
  readonly fileBytes: number;
  readonly totalLines: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly truncated: boolean;
  readonly fromDryRunOverlay: boolean;
}

export class ReadFileTool {
  readonly #guard: ToolDependencies["workspaceGuard"];
  readonly #overlay: DryRunOverlay;

  public constructor(dependencies: ToolDependencies) {
    this.#guard = dependencies.workspaceGuard;
    this.#overlay =
      dependencies.overlay instanceof DryRunOverlay ? dependencies.overlay : new DryRunOverlay();
  }

  public async execute(input: unknown): Promise<ReadFileResult> {
    const parsed = parseToolInput(ReadFileInputSchema, input);
    const guarded = await this.#guard.resolveForRead(parsed.path);
    const overlayContent = this.#overlay.get(guarded.relativePath);
    const fromDryRunOverlay = overlayContent !== undefined;
    const file = fromDryRunOverlay
      ? {
          content: overlayContent,
          size: Buffer.byteLength(overlayContent, "utf8"),
        }
      : await readUtf8File(guarded.absolutePath);

    const lines = file.content.split(/\r?\n/u);
    const startLine = parsed.startLine ?? 1;
    const requestedEnd = parsed.endLine ?? lines.length;
    const endLine = Math.min(requestedEnd, lines.length);
    const selected =
      startLine > lines.length || endLine < startLine
        ? ""
        : lines.slice(startLine - 1, endLine).join("\n");
    const bounded = truncateUtf8(selected, parsed.maxOutputBytes);

    return {
      path: guarded.relativePath,
      content: bounded.value,
      sha256: sha256(file.content),
      fileBytes: file.size,
      totalLines: lines.length,
      startLine,
      endLine,
      truncated: bounded.truncated,
      fromDryRunOverlay,
    };
  }
}
