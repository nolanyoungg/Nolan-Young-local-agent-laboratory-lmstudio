export type FilesystemToolErrorCode =
  | "BINARY_FILE"
  | "FILE_EXISTS"
  | "FILE_NOT_FOUND"
  | "FILE_TOO_LARGE"
  | "HASH_MISMATCH"
  | "INVALID_INPUT"
  | "IO_ERROR"
  | "NOT_A_DIRECTORY"
  | "NOT_A_FILE"
  | "PATCH_FAILED"
  | "VALIDATION_DENIED";

export class FilesystemToolError extends Error {
  public readonly code: FilesystemToolErrorCode;

  public constructor(code: FilesystemToolErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FilesystemToolError";
    this.code = code;
  }
}

export function asFilesystemToolError(
  error: unknown,
  fallbackMessage: string,
): FilesystemToolError {
  if (error instanceof FilesystemToolError) {
    return error;
  }

  if (isNodeError(error)) {
    if (error.code === "ENOENT") {
      return new FilesystemToolError("FILE_NOT_FOUND", fallbackMessage, {
        cause: error,
      });
    }
    if (error.code === "EEXIST") {
      return new FilesystemToolError("FILE_EXISTS", fallbackMessage, {
        cause: error,
      });
    }
  }

  return new FilesystemToolError("IO_ERROR", fallbackMessage, {
    cause: error,
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
