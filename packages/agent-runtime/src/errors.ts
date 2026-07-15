export type AgentRuntimeErrorCode =
  | "CONTEXT_BUDGET_EXCEEDED"
  | "DISALLOWED_TOOL"
  | "DUPLICATE_CALL_ID_CONFLICT"
  | "INVALID_TOOL_INPUT"
  | "INVALID_MODEL_RESPONSE"
  | "LOOP_DETECTED"
  | "PATCH_RECOVERY_REQUIRED"
  | "STEP_LIMIT_EXCEEDED"
  | "TOOL_EXECUTION_FAILED"
  | "UNKNOWN_TOOL";

export class AgentRuntimeError extends Error {
  public constructor(
    public readonly code: AgentRuntimeErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentRuntimeError";
  }
}
