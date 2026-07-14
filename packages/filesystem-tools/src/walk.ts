import { lstat, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import type { WorkspaceGuardLike } from "./types.js";

export interface WalkedEntry {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly type: "directory" | "file";
  readonly size: number;
}

export async function walkReadableEntries(
  guard: WorkspaceGuardLike,
  requestedPath: string,
  recursive: boolean,
  maximumCandidates: number,
): Promise<{ readonly entries: readonly WalkedEntry[]; readonly truncated: boolean }> {
  const base = await guard.resolveForRead(requestedPath);
  const baseMetadata = await lstat(base.absolutePath);
  if (baseMetadata.isFile()) {
    return {
      entries: [
        {
          absolutePath: base.absolutePath,
          relativePath: base.relativePath,
          type: "file",
          size: baseMetadata.size,
        },
      ],
      truncated: false,
    };
  }
  if (!baseMetadata.isDirectory()) {
    return { entries: [], truncated: false };
  }

  const entries: WalkedEntry[] = [];
  let truncated = false;

  async function visit(absoluteDirectory: string, relativeDirectory: string): Promise<void> {
    if (truncated) {
      return;
    }
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      if (entries.length >= maximumCandidates) {
        truncated = true;
        return;
      }
      const relativePath = posix.join(relativeDirectory.replaceAll("\\", "/"), child.name);

      let guarded;
      try {
        guarded = await guard.resolveForRead(relativePath);
      } catch {
        continue;
      }
      if (child.isSymbolicLink()) {
        continue;
      }

      const absolutePath = join(absoluteDirectory, child.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isFile()) {
        entries.push({
          absolutePath: guarded.absolutePath,
          relativePath: guarded.relativePath,
          type: "file",
          size: metadata.size,
        });
      } else if (metadata.isDirectory()) {
        entries.push({
          absolutePath: guarded.absolutePath,
          relativePath: guarded.relativePath,
          type: "directory",
          size: 0,
        });
        if (recursive) {
          await visit(absolutePath, guarded.relativePath);
        }
      }
    }
  }

  await visit(base.absolutePath, base.relativePath === "." ? "" : base.relativePath);
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { entries, truncated };
}
