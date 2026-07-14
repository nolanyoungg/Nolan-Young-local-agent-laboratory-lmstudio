import { posix } from "node:path";
import { z } from "zod";
import { DryRunOverlay } from "./DryRunOverlay.js";
import { parseToolInput, utf8Bytes } from "./internal.js";
import { MAX_OUTPUT_BYTES, type ToolDependencies } from "./types.js";
import { walkReadableEntries } from "./walk.js";

export const ListFilesInputSchema = z
  .object({
    path: z.string().min(1).default("."),
    recursive: z.boolean().default(false),
    maxResults: z.number().int().positive().max(2_000).default(2_000),
  })
  .strict();

export interface ListedFile {
  readonly path: string;
  readonly type: "directory" | "file";
  readonly size: number;
  readonly fromDryRunOverlay: boolean;
}

export interface ListFilesResult {
  readonly path: string;
  readonly entries: readonly ListedFile[];
  readonly truncated: boolean;
}

export class ListFilesTool {
  readonly #guard: ToolDependencies["workspaceGuard"];
  readonly #overlay: DryRunOverlay;

  public constructor(dependencies: ToolDependencies) {
    this.#guard = dependencies.workspaceGuard;
    this.#overlay =
      dependencies.overlay instanceof DryRunOverlay ? dependencies.overlay : new DryRunOverlay();
  }

  public async execute(input: unknown): Promise<ListFilesResult> {
    const parsed = parseToolInput(ListFilesInputSchema, input);
    const walked = await walkReadableEntries(
      this.#guard,
      parsed.path,
      parsed.recursive,
      Math.min(parsed.maxResults + 1, 2_001),
    );
    const base = await this.#guard.resolveForRead(parsed.path);
    const byPath = new Map<string, ListedFile>();

    for (const entry of walked.entries) {
      byPath.set(entry.relativePath, {
        path: entry.relativePath,
        type: entry.type,
        size: entry.size,
        fromDryRunOverlay: false,
      });
    }

    for (const [relativePath, content] of this.#overlay.entries()) {
      if (!isWithin(relativePath, base.relativePath, parsed.recursive)) {
        continue;
      }
      byPath.set(relativePath, {
        path: relativePath,
        type: "file",
        size: utf8Bytes(content),
        fromDryRunOverlay: true,
      });
    }

    const candidates = [...byPath.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    const entries: ListedFile[] = [];
    let outputBytes = 2;
    let truncated = walked.truncated;

    for (const entry of candidates) {
      const entryBytes = utf8Bytes(JSON.stringify(entry)) + 1;
      if (entries.length >= parsed.maxResults || outputBytes + entryBytes > MAX_OUTPUT_BYTES) {
        truncated = true;
        break;
      }
      entries.push(entry);
      outputBytes += entryBytes;
    }

    return { path: base.relativePath, entries, truncated };
  }
}

function isWithin(candidate: string, base: string, recursive: boolean): boolean {
  const normalizedCandidate = posix.normalize(candidate.replaceAll("\\", "/"));
  const normalizedBase = posix.normalize(base.replaceAll("\\", "/"));
  if (normalizedCandidate === normalizedBase) {
    return true;
  }
  const prefix = normalizedBase === "." ? "" : `${normalizedBase}/`;
  if (!normalizedCandidate.startsWith(prefix)) {
    return false;
  }
  const remainder = normalizedCandidate.slice(prefix.length);
  return recursive || !remainder.includes("/");
}
