import { lstat } from "node:fs/promises";
import path from "node:path";

import { WorkspaceSecurityError } from "./errors.js";
import { PathPolicy, type PathOperation, type PathPolicyOptions } from "./PathPolicy.js";
import { ReadPolicy } from "./ReadPolicy.js";
import { canonicalizeWorkspaceRoot, isPathInside, SymlinkGuard } from "./SymlinkGuard.js";
import { WritePolicy } from "./WritePolicy.js";

export interface ResolvedWorkspacePath {
  readonly absolutePath: string;
  readonly relativePath: string;
}

export interface WorkspaceGuardOptions extends PathPolicyOptions {
  readonly pathPolicy?: PathPolicy;
}

export class WorkspaceGuard {
  public readonly pathPolicy: PathPolicy;
  public readonly readPolicy: ReadPolicy;
  public readonly root: string;
  public readonly workspaceRoot: string;
  public readonly writePolicy: WritePolicy;
  readonly #symlinkGuard: SymlinkGuard;

  private constructor(canonicalRoot: string, pathPolicy: PathPolicy) {
    this.root = canonicalRoot;
    this.workspaceRoot = canonicalRoot;
    this.pathPolicy = pathPolicy;
    this.readPolicy = new ReadPolicy(pathPolicy);
    this.writePolicy = new WritePolicy(pathPolicy);
    this.#symlinkGuard = new SymlinkGuard(canonicalRoot);
  }

  public static async create(
    workspaceRoot: string,
    options: WorkspaceGuardOptions = {},
  ): Promise<WorkspaceGuard> {
    const canonicalRoot = await canonicalizeWorkspaceRoot(workspaceRoot);
    const pathPolicy = options.pathPolicy ?? new PathPolicy(options);
    return new WorkspaceGuard(canonicalRoot, pathPolicy);
  }

  public async resolvePath(
    relativePath: string,
    operation: PathOperation,
  ): Promise<ResolvedWorkspacePath> {
    const normalized = this.pathPolicy.assertAllowed(relativePath, operation);
    const absolutePath =
      normalized === "." ? this.root : path.resolve(this.root, ...normalized.split("/"));

    if (!isPathInside(this.root, absolutePath)) {
      throw new WorkspaceSecurityError(
        "OUTSIDE_WORKSPACE",
        "Resolved path is outside the workspace root",
        { path: absolutePath },
      );
    }
    await this.#symlinkGuard.assertSafe(absolutePath);
    return { absolutePath, relativePath: normalized };
  }

  public async resolveForRead(relativePath: string): Promise<ResolvedWorkspacePath> {
    return this.resolvePath(relativePath, "read");
  }

  public async resolveForWrite(
    relativePath: string,
    options: Readonly<{ mustExist: boolean }> = { mustExist: false },
  ): Promise<ResolvedWorkspacePath> {
    const resolved = await this.resolvePath(relativePath, "write");
    if (options.mustExist) {
      try {
        await lstat(resolved.absolutePath);
      } catch (error) {
        throw new WorkspaceSecurityError("INVALID_PATH", "Writable path must already exist", {
          cause: error,
          path: resolved.absolutePath,
        });
      }
    }
    return resolved;
  }

  public async resolveForDelete(relativePath: string): Promise<ResolvedWorkspacePath> {
    return this.resolvePath(relativePath, "delete");
  }

  public async resolveReadPath(relativePath: string): Promise<string> {
    return (await this.resolveForRead(relativePath)).absolutePath;
  }

  public async resolveWritePath(relativePath: string): Promise<string> {
    return (await this.resolveForWrite(relativePath)).absolutePath;
  }

  public async resolveDeletePath(relativePath: string): Promise<string> {
    return (await this.resolveForDelete(relativePath)).absolutePath;
  }

  public async assertReadable(relativePath: string): Promise<ResolvedWorkspacePath> {
    return this.resolveForRead(relativePath);
  }

  public async assertWritable(relativePath: string): Promise<ResolvedWorkspacePath> {
    return this.resolveForWrite(relativePath);
  }
}
