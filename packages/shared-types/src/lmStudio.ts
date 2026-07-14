import { z } from "zod";

import { ModelIdentifierSchema } from "./models.js";

export const DEFAULT_LM_STUDIO_BASE_URL = "http://127.0.0.1:1234";
export const DEFAULT_LM_STUDIO_MODEL = "qwen/qwen2.5-coder-14b";
export const DEFAULT_MODEL_CONNECTION_TIMEOUT_MS = 15_000;
export const DEFAULT_MODEL_RESOLUTION_TIMEOUT_MS = 60_000;
export const DEFAULT_MODEL_LOAD_TIMEOUT_MS = 300_000;
export const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 300_000;
export const DEFAULT_MODEL_MAX_RETRIES = 2;
export const DEFAULT_MODEL_RETRY_DELAY_MS = 2_000;
export const DEFAULT_MODEL_CONTEXT_TOKENS = 32_768;
export const DEFAULT_MODEL_TEMPERATURE = 0.1;

export const LMStudioBaseUrlSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const isLoopback =
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "[::1]" ||
      hostname === "::1";

    if (url.protocol !== "http:") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "LM Studio URL must use HTTP; the SDK WebSocket URL is derived internally",
      });
    }
    if (!isLoopback) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "LM Studio URL must use the local loopback interface",
      });
    }
    if (url.username.length > 0 || url.password.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "LM Studio URL must not contain credentials",
      });
    }
    if (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "LM Studio URL must not contain a path, query string, or fragment",
      });
    }
  });

export const LMStudioConnectionConfigSchema = z
  .object({
    baseUrl: LMStudioBaseUrlSchema.default(DEFAULT_LM_STUDIO_BASE_URL),
    model: ModelIdentifierSchema.default(DEFAULT_LM_STUDIO_MODEL),
    apiToken: z.string().min(1).max(16_384).optional(),
    connectionTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .default(DEFAULT_MODEL_CONNECTION_TIMEOUT_MS),
    modelResolutionTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .default(DEFAULT_MODEL_RESOLUTION_TIMEOUT_MS),
    modelLoadTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .default(DEFAULT_MODEL_LOAD_TIMEOUT_MS),
    requestTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .default(DEFAULT_MODEL_REQUEST_TIMEOUT_MS),
    maxRetries: z.number().int().min(0).max(2).default(DEFAULT_MODEL_MAX_RETRIES),
    retryDelayMs: z.number().int().nonnegative().max(300_000).default(DEFAULT_MODEL_RETRY_DELAY_MS),
    contextTokens: z.number().int().min(512).max(1_048_576).default(DEFAULT_MODEL_CONTEXT_TOKENS),
    temperature: z.number().min(0).max(2).default(DEFAULT_MODEL_TEMPERATURE),
  })
  .strict();

export type LMStudioConnectionConfig = z.infer<typeof LMStudioConnectionConfigSchema>;

export const LMStudioDiagnosticStatusSchema = z.enum(["PASS", "WARNING", "FAIL", "SKIPPED"]);

export const LMStudioDiagnosticResultSchema = z
  .object({
    check: z.string().min(1).max(256),
    status: LMStudioDiagnosticStatusSchema,
    message: z.string().min(1).max(16_384),
    durationMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export type LMStudioDiagnosticResult = z.infer<typeof LMStudioDiagnosticResultSchema>;
