export type BuildAssistantErrorCategory =
  "configuration" | "infrastructure" | "interrupted" | "model" | "workflow";

const EXIT_CODES: Readonly<Record<BuildAssistantErrorCategory, number>> = {
  configuration: 2,
  infrastructure: 3,
  interrupted: 130,
  model: 3,
  workflow: 1,
};

export class BuildAssistantError extends Error {
  public readonly exitCode: number;

  public constructor(
    public readonly code: string,
    message: string,
    public readonly category: BuildAssistantErrorCategory,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "BuildAssistantError";
    this.exitCode = EXIT_CODES[category];
  }
}

export function asBuildAssistantError(error: unknown): BuildAssistantError {
  if (error instanceof BuildAssistantError) return error;
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  if (code === "PROCESS_ABORTED" || code === "CANCELLED") {
    return new BuildAssistantError(
      "INTERRUPTED",
      "The Build Assistant workflow was interrupted.",
      "interrupted",
      { cause: error },
    );
  }
  if (error instanceof Error && error.name === "ModelClientError") {
    return new BuildAssistantError("MODEL_OPERATION_FAILED", error.message, "model", {
      cause: error,
    });
  }
  if (
    error instanceof Error &&
    (error.name === "ProcessToolError" || error.name === "TraceError")
  ) {
    return new BuildAssistantError("INFRASTRUCTURE_FAILED", error.message, "infrastructure", {
      cause: error,
    });
  }
  if (
    error instanceof Error &&
    (error.name === "WorkspaceLockError" ||
      error.name === "WorkspaceSecurityError" ||
      error.name === "PathPolicyError" ||
      error.name === "PathValidationError")
  ) {
    return new BuildAssistantError(
      "WORKSPACE_CONFIGURATION_REJECTED",
      error.message,
      "configuration",
      { cause: error },
    );
  }
  return new BuildAssistantError(
    "WORKFLOW_FAILED",
    error instanceof Error ? error.message : "The build workflow failed.",
    "workflow",
    { cause: error },
  );
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
