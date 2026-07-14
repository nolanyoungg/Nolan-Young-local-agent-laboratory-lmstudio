import { z } from "zod";
import { DryRunOverlay } from "./DryRunOverlay.js";
import { parseToolInput, readUtf8File, truncateUtf8, utf8Bytes } from "./internal.js";
import { MAX_OUTPUT_BYTES, type ToolDependencies } from "./types.js";
import { walkReadableEntries } from "./walk.js";

export const SearchTextInputSchema = z
  .object({
    path: z.string().min(1).default("."),
    query: z.string().min(1).max(1_000),
    caseSensitive: z.boolean().default(false),
    maxResults: z.number().int().positive().max(200).default(200),
  })
  .strict();

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly fromDryRunOverlay: boolean;
}

export interface SearchTextResult {
  readonly query: string;
  readonly matches: readonly SearchMatch[];
  readonly searchedFiles: number;
  readonly skippedBinaryOrOversizedFiles: number;
  readonly truncated: boolean;
}

export class SearchTextTool {
  readonly #guard: ToolDependencies["workspaceGuard"];
  readonly #overlay: DryRunOverlay;

  public constructor(dependencies: ToolDependencies) {
    this.#guard = dependencies.workspaceGuard;
    this.#overlay =
      dependencies.overlay instanceof DryRunOverlay ? dependencies.overlay : new DryRunOverlay();
  }

  public async execute(input: unknown): Promise<SearchTextResult> {
    const parsed = parseToolInput(SearchTextInputSchema, input);
    const walked = await walkReadableEntries(this.#guard, parsed.path, true, 10_000);
    const diskFiles = walked.entries.filter((entry) => entry.type === "file");
    const fileMap = new Map(
      diskFiles.map((entry) => [
        entry.relativePath,
        {
          absolutePath: entry.absolutePath,
          relativePath: entry.relativePath,
          overlayContent: undefined as string | undefined,
        },
      ]),
    );
    const base = await this.#guard.resolveForRead(parsed.path);
    const basePrefix = base.relativePath === "." ? "" : `${base.relativePath}/`;
    for (const [relativePath, content] of this.#overlay.entries()) {
      if (relativePath === base.relativePath || relativePath.startsWith(basePrefix)) {
        const guarded = await this.#guard.resolveForRead(relativePath);
        fileMap.set(relativePath, {
          absolutePath: guarded.absolutePath,
          relativePath: guarded.relativePath,
          overlayContent: content,
        });
      }
    }

    const files = [...fileMap.values()].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
    const needle = parsed.caseSensitive ? parsed.query : parsed.query.toLowerCase();
    const matches: SearchMatch[] = [];
    let outputBytes = 2;
    let searchedFiles = 0;
    let skippedBinaryOrOversizedFiles = 0;
    let truncated = walked.truncated;

    fileLoop: for (const file of files) {
      let content: string;
      try {
        content = file.overlayContent ?? (await readUtf8File(file.absolutePath)).content;
      } catch {
        skippedBinaryOrOversizedFiles += 1;
        continue;
      }
      searchedFiles += 1;
      const lines = content.split(/\r?\n/u);
      for (const [lineIndex, line] of lines.entries()) {
        const haystack = parsed.caseSensitive ? line : line.toLowerCase();
        const columnIndex = haystack.indexOf(needle);
        if (columnIndex === -1) {
          continue;
        }
        const match: SearchMatch = {
          path: file.relativePath,
          line: lineIndex + 1,
          column: columnIndex + 1,
          text: truncateUtf8(line, 1_024).value,
          fromDryRunOverlay: file.overlayContent !== undefined,
        };
        const matchBytes = utf8Bytes(JSON.stringify(match)) + 1;
        if (matches.length >= parsed.maxResults || outputBytes + matchBytes > MAX_OUTPUT_BYTES) {
          truncated = true;
          break fileLoop;
        }
        matches.push(match);
        outputBytes += matchBytes;
      }
    }

    return {
      query: parsed.query,
      matches,
      searchedFiles,
      skippedBinaryOrOversizedFiles,
      truncated,
    };
  }
}
