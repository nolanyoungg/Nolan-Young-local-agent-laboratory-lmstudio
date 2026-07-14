export type ReleaseErrorCategory =
  "configuration" | "infrastructure" | "interrupted" | "model" | "security" | "workflow";

const EXIT_CODES: Readonly<Record<ReleaseErrorCategory, number>> = {
  configuration: 2,
  infrastructure: 3,
  interrupted: 130,
  model: 3,
  security: 2,
  workflow: 1,
};

export class ReleaseEngineerError extends Error {
  public readonly category: ReleaseErrorCategory;
  public readonly code: string;
  public readonly exitCode: number;

  public constructor(
    code: string,
    message: string,
    category: ReleaseErrorCategory,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "ReleaseEngineerError";
    this.code = code;
    this.category = category;
    this.exitCode = EXIT_CODES[category];
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
