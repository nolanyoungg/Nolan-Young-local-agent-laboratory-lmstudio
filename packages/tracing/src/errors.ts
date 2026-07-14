export class TraceError extends Error {
  public readonly code: string;
  public readonly causeValue: unknown;

  public constructor(code: string, message: string, causeValue?: unknown) {
    super(message);
    this.name = "TraceError";
    this.code = code;
    this.causeValue = causeValue;
  }
}
