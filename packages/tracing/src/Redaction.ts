const REDACTED = "[REDACTED]";
const SECRET_KEY = /(?:token|authorization|password|passwd|secret|api[_-]?key|credential|cookie)/i;
const SAFE_USAGE_METRIC_KEYS = new Set(["promptTokens", "completionTokens", "totalTokens"]);
const AUTHORIZATION_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const LM_TOKEN_VALUE = /\blm_[A-Za-z0-9_-]{8,}\b/g;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const WINDOWS_ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|]+/gu;
const POSIX_ABSOLUTE_PATH =
  /(^|[\s(=:])\/(?:Users|home|mnt|opt|private|root|srv|tmp|var|workspace|workspaces)(?:\/[^\s"'`<>|]+)*/gu;

function redactString(value: string): string {
  return value
    .replace(AUTHORIZATION_VALUE, `Bearer ${REDACTED}`)
    .replace(LM_TOKEN_VALUE, REDACTED)
    .replace(PRIVATE_KEY, REDACTED)
    .replace(WINDOWS_ABSOLUTE_PATH, "[ABSOLUTE PATH REDACTED]")
    .replace(POSIX_ABSOLUTE_PATH, (_match, prefix: string) => `${prefix}[ABSOLUTE PATH REDACTED]`);
}

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] =
      SAFE_USAGE_METRIC_KEYS.has(key) && typeof item === "number"
        ? item
        : SECRET_KEY.test(key)
          ? REDACTED
          : redact(item, seen);
  }
  return output;
}

export function sanitizedError(error: unknown): { name: string; message: string; code?: string } {
  if (!(error instanceof Error))
    return { name: "UnknownError", message: redactString(String(error)) };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return {
    name: error.name,
    message: redactString(error.message),
    ...(code === undefined ? {} : { code }),
  };
}
