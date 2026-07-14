export type WorkspaceSecurityErrorCode =
  | "ABSOLUTE_PATH"
  | "DELETE_DENIED"
  | "INVALID_PATH"
  | "INVALID_WORKSPACE"
  | "LOCK_HELD"
  | "LOCK_IO"
  | "LOCK_OWNERSHIP"
  | "MALFORMED_PATH"
  | "OUTSIDE_WORKSPACE"
  | "PATH_FORBIDDEN"
  | "PATH_TOO_LONG"
  | "PATH_TRAVERSAL"
  | "READ_DENIED"
  | "SYMLINK_DETECTED"
  | "WRITE_DENIED";

export interface WorkspaceSecurityErrorOptions {
  readonly cause?: unknown;
  readonly path?: string;
}

export class WorkspaceSecurityError extends Error {
  public readonly code: WorkspaceSecurityErrorCode;
  public readonly path: string | undefined;

  public constructor(
    code: WorkspaceSecurityErrorCode,
    message: string,
    options: WorkspaceSecurityErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WorkspaceSecurityError";
    this.code = code;
    this.path = options.path;
  }
}

export class PathValidationError extends WorkspaceSecurityError {
  public constructor(
    code: Extract<
      WorkspaceSecurityErrorCode,
      "ABSOLUTE_PATH" | "INVALID_PATH" | "MALFORMED_PATH" | "PATH_TOO_LONG" | "PATH_TRAVERSAL"
    >,
    message: string,
    path: string,
  ) {
    super(code, message, { path });
    this.name = "PathValidationError";
  }
}

export class PathPolicyError extends WorkspaceSecurityError {
  public constructor(
    code: Extract<
      WorkspaceSecurityErrorCode,
      "DELETE_DENIED" | "PATH_FORBIDDEN" | "READ_DENIED" | "WRITE_DENIED"
    >,
    message: string,
    path: string,
  ) {
    super(code, message, { path });
    this.name = "PathPolicyError";
  }
}

export class SymlinkSecurityError extends WorkspaceSecurityError {
  public constructor(message: string, path: string) {
    super("SYMLINK_DETECTED", message, { path });
    this.name = "SymlinkSecurityError";
  }
}

export class WorkspaceLockError extends WorkspaceSecurityError {
  public constructor(
    code: Extract<WorkspaceSecurityErrorCode, "LOCK_HELD" | "LOCK_IO" | "LOCK_OWNERSHIP">,
    message: string,
    options: WorkspaceSecurityErrorOptions = {},
  ) {
    super(code, message, options);
    this.name = "WorkspaceLockError";
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
