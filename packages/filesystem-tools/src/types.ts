export const MAX_FILE_BYTES = 1_048_576;
export const MAX_OUTPUT_BYTES = 131_072;

export interface GuardedWorkspacePath {
  readonly absolutePath: string;
  readonly relativePath: string;
}

/**
 * The deliberately narrow, structurally typed boundary expected from
 * workspace-security. The concrete WorkspaceGuard retains ownership of all
 * path, policy, traversal, and symlink checks.
 */
export interface WorkspaceGuardLike {
  resolveForRead(relativePath: string): Promise<GuardedWorkspacePath>;
  resolveForWrite(
    relativePath: string,
    options: Readonly<{ mustExist: boolean }>,
  ): Promise<GuardedWorkspacePath>;
}

export interface FileMutationResult {
  readonly path: string;
  readonly dryRun: boolean;
  readonly bytes: number;
  readonly beforeSha256: string | null;
  readonly afterSha256: string;
}

export interface ToolDependencies {
  readonly workspaceGuard: WorkspaceGuardLike;
  readonly dryRun?: boolean;
  readonly overlay?: DryRunOverlayLike;
}

export interface DryRunOverlayLike {
  has(relativePath: string): boolean;
  get(relativePath: string): string | undefined;
  set(relativePath: string, content: string): void;
  entries(): readonly (readonly [string, string])[];
}
