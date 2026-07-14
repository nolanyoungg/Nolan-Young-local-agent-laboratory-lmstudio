import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { isNodeError, SymlinkSecurityError, WorkspaceSecurityError } from "./errors.js";

function pathComparisonValue(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export async function canonicalizeWorkspaceRoot(workspaceRoot: string): Promise<string> {
  const absoluteRoot = path.resolve(workspaceRoot);
  let rootStat;
  try {
    rootStat = await lstat(absoluteRoot);
  } catch (error) {
    throw new WorkspaceSecurityError(
      "INVALID_WORKSPACE",
      `Workspace root does not exist or cannot be inspected: ${absoluteRoot}`,
      { cause: error, path: absoluteRoot },
    );
  }

  if (rootStat.isSymbolicLink()) {
    throw new SymlinkSecurityError(
      "Workspace root must not be a symlink or junction",
      absoluteRoot,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new WorkspaceSecurityError("INVALID_WORKSPACE", "Workspace root must be a directory", {
      path: absoluteRoot,
    });
  }

  const canonicalRoot = await realpath(absoluteRoot);
  return path.resolve(canonicalRoot);
}

export class SymlinkGuard {
  readonly #canonicalRoot: string;

  public constructor(canonicalRoot: string) {
    if (!path.isAbsolute(canonicalRoot)) {
      throw new TypeError("SymlinkGuard requires an absolute canonical root");
    }
    this.#canonicalRoot = path.resolve(canonicalRoot);
  }

  public async assertSafe(absolutePath: string): Promise<void> {
    const candidate = path.resolve(absolutePath);
    if (!isPathInside(this.#canonicalRoot, candidate)) {
      throw new WorkspaceSecurityError(
        "OUTSIDE_WORKSPACE",
        "Resolved path is outside the canonical workspace root",
        { path: candidate },
      );
    }

    const relative = path.relative(this.#canonicalRoot, candidate);
    if (relative === "") {
      return;
    }

    let current = this.#canonicalRoot;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        const currentStat = await lstat(current);
        if (currentStat.isSymbolicLink()) {
          throw new SymlinkSecurityError(
            "Symlink or junction components are not allowed in workspace paths",
            current,
          );
        }

        const canonicalCurrent = await realpath(current);
        if (!isPathInside(this.#canonicalRoot, canonicalCurrent)) {
          throw new SymlinkSecurityError("Path component resolves outside the workspace", current);
        }

        if (pathComparisonValue(canonicalCurrent) !== pathComparisonValue(current)) {
          throw new SymlinkSecurityError(
            "Path component has an unexpected reparse or alias target",
            current,
          );
        }
      } catch (error) {
        if (error instanceof SymlinkSecurityError) {
          throw error;
        }
        if (isNodeError(error) && error.code === "ENOENT") {
          return;
        }
        throw new WorkspaceSecurityError("INVALID_PATH", "Path component cannot be inspected", {
          cause: error,
          path: current,
        });
      }
    }
  }
}
