export type ProcessToolErrorCode =
  | "COMMAND_NOT_ALLOWED"
  | "DUPLICATE_COMMAND"
  | "INVALID_COMMAND_DEFINITION"
  | "INVALID_NPM_EXEC_PATH"
  | "PROCESS_ABORTED"
  | "PROCESS_SPAWN_FAILED"
  | "PROCESS_TERMINATION_FAILED"
  | "WATCHER_NOT_FOUND";

export class ProcessToolError extends Error {
  public readonly code: ProcessToolErrorCode;

  public constructor(code: ProcessToolErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProcessToolError";
    this.code = code;
  }
}
