export const ModelClientErrorCode = {
  configurationInvalid: "CONFIGURATION_INVALID",
  endpointInvalid: "ENDPOINT_INVALID",
  endpointUnavailable: "ENDPOINT_UNAVAILABLE",
  authenticationRequired: "AUTHENTICATION_REQUIRED",
  invalidToken: "INVALID_TOKEN",
  incompatibleVersion: "INCOMPATIBLE_VERSION",
  invalidResponse: "INVALID_RESPONSE",
  modelMissing: "MODEL_MISSING",
  modelAmbiguous: "MODEL_AMBIGUOUS",
  modelLoadFailed: "MODEL_LOAD_FAILED",
  timeout: "TIMEOUT",
  cancelled: "CANCELLED",
  emptyResponse: "EMPTY_RESPONSE",
  malformedResponse: "MALFORMED_RESPONSE",
  mockExhausted: "MOCK_EXHAUSTED",
} as const;

export type ModelClientErrorCodeValue =
  (typeof ModelClientErrorCode)[keyof typeof ModelClientErrorCode];

export interface StructuredError {
  readonly code: ModelClientErrorCodeValue;
  readonly message: string;
  readonly retryable: boolean;
}

const AUTHORIZATION_PATTERN = /\b(?:bearer|token|authorization)\s*[:=]?\s*[^\s,;]+/giu;

export function redactSensitiveText(message: string, secrets: readonly string[] = []): string {
  let redacted = message.replaceAll(AUTHORIZATION_PATTERN, "[REDACTED]");
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
  }
  return redacted.slice(0, 2_000);
}

export class ModelClientError extends Error {
  public readonly code: ModelClientErrorCodeValue;
  public readonly details: Readonly<Record<string, unknown>>;
  public readonly retryable: boolean;

  public constructor(
    code: ModelClientErrorCodeValue,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly cause?: unknown;
      readonly details?: Readonly<Record<string, unknown>>;
      readonly secrets?: readonly string[];
    } = {},
  ) {
    super(redactSensitiveText(message, options.secrets), { cause: options.cause });
    this.name = "ModelClientError";
    this.code = code;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? false;
  }

  public toStructuredError(): StructuredError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export function toModelClientError(
  error: unknown,
  fallbackCode: ModelClientErrorCodeValue,
  fallbackMessage: string,
  options: { readonly retryable?: boolean; readonly secrets?: readonly string[] } = {},
): ModelClientError {
  if (error instanceof ModelClientError) {
    if (options.secrets === undefined || options.secrets.length === 0) {
      return error;
    }
    return new ModelClientError(error.code, error.message, {
      retryable: error.retryable,
      details: error.details,
      secrets: options.secrets,
    });
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ModelClientError(ModelClientErrorCode.cancelled, "Model operation was cancelled.", {
      ...(options.secrets === undefined || options.secrets.length === 0 ? { cause: error } : {}),
    });
  }
  return new ModelClientError(fallbackCode, fallbackMessage, {
    ...(options.secrets === undefined || options.secrets.length === 0 ? { cause: error } : {}),
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
  });
}
