import { z } from "zod";

import { IdentifierSchema, IsoDateTimeSchema, JsonValueSchema } from "./json.js";

export const ModelProviderSchema = z.enum(["lmstudio", "mock"]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const ModelIdentifierSchema = z.string().trim().min(1).max(512);
export type ModelIdentifier = z.infer<typeof ModelIdentifierSchema>;

export const ModelMessageRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

export const ModelMessageSchema = z
  .object({
    role: ModelMessageRoleSchema,
    content: z.string().max(1_000_000),
    name: IdentifierSchema.optional(),
    toolCallId: z.string().uuid().optional(),
  })
  .strict();

export type ModelMessage = z.infer<typeof ModelMessageSchema>;

export const ModelResponseFormatSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }).strict(),
  z
    .object({
      type: z.literal("json"),
      name: IdentifierSchema,
      schema: JsonValueSchema,
    })
    .strict(),
]);

export type ModelResponseFormat = z.infer<typeof ModelResponseFormatSchema>;

export const ModelCompletionRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    model: ModelIdentifierSchema,
    messages: z.array(ModelMessageSchema).min(1).max(1_000),
    temperature: z.number().min(0).max(2).default(0.1),
    contextTokens: z.number().int().min(512).max(1_048_576).default(32_768),
    maxOutputTokens: z.number().int().positive().max(262_144).optional(),
    responseFormat: ModelResponseFormatSchema.default({ type: "text" }),
    timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  })
  .strict();

export type ModelCompletionRequest = z.infer<typeof ModelCompletionRequestSchema>;

export const ModelTokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((usage, context) => {
    if (usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "totalTokens must equal inputTokens plus outputTokens",
        path: ["totalTokens"],
      });
    }
  });

export const ModelFinishReasonSchema = z.enum([
  "stop",
  "length",
  "tool_calls",
  "cancelled",
  "error",
  "unknown",
]);

export const ModelCompletionResponseSchema = z
  .object({
    requestId: z.string().uuid(),
    model: ModelIdentifierSchema,
    provider: ModelProviderSchema,
    content: z.string().max(1_000_000),
    structuredOutput: JsonValueSchema.optional(),
    finishReason: ModelFinishReasonSchema,
    usage: ModelTokenUsageSchema.optional(),
    durationMs: z.number().int().nonnegative(),
    receivedAt: IsoDateTimeSchema,
  })
  .strict();

export type ModelCompletionResponse = z.infer<typeof ModelCompletionResponseSchema>;

export const AvailableModelSchema = z
  .object({
    identifier: ModelIdentifierSchema,
    displayName: z.string().trim().min(1).max(512).optional(),
    type: z.string().trim().min(1).max(128).optional(),
    loaded: z.boolean().optional(),
    contextLength: z.number().int().positive().optional(),
    device: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export type AvailableModel = z.infer<typeof AvailableModelSchema>;

export const ResolvedModelSchema = AvailableModelSchema.extend({
  requestedIdentifier: ModelIdentifierSchema,
  match: z.enum(["exact", "case-insensitive", "display-name"]),
}).strict();

export type ResolvedModel = z.infer<typeof ResolvedModelSchema>;

export const ModelHealthStatusSchema = z
  .object({
    status: z.enum(["healthy", "degraded", "unavailable"]),
    provider: ModelProviderSchema,
    endpoint: z.string().url().optional(),
    checkedAt: IsoDateTimeSchema,
    latencyMs: z.number().int().nonnegative().optional(),
    message: z.string().min(1).max(8_192),
  })
  .strict();

export type ModelHealthStatus = z.infer<typeof ModelHealthStatusSchema>;
