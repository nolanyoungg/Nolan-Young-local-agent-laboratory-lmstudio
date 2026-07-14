import { z, type ZodType } from "zod";

import type { StructuredError } from "./errors.js";

export const ModelMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().min(1).max(1_000_000),
  })
  .strict();

export type ModelMessage = z.infer<typeof ModelMessageSchema>;

export const ModelCompletionRequestSchema = z
  .object({
    messages: z.array(ModelMessageSchema).min(1).max(512),
    model: z.string().trim().min(1).max(512).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(32_768).optional(),
  })
  .strict();

type ParsedModelCompletionRequest = z.infer<typeof ModelCompletionRequestSchema>;

export type ModelCompletionRequest = ParsedModelCompletionRequest & {
  readonly signal?: AbortSignal;
};

export const ModelTransportSchema = z.enum(["sdk", "rest", "mock"]);
export type ModelTransport = z.infer<typeof ModelTransportSchema>;

export interface ModelCompletionResponse<T> {
  readonly value: T;
  readonly content: string;
  readonly model: string;
  readonly transport: ModelTransport;
  readonly attempts: number;
  readonly durationMs: number;
  readonly stopReason?: string;
}

export function ModelCompletionResponseSchema<T>(outputSchema: ZodType<T>) {
  return z
    .object({
      value: outputSchema,
      content: z.string().min(1),
      model: z.string().min(1),
      transport: ModelTransportSchema,
      attempts: z.number().int().positive(),
      durationMs: z.number().nonnegative(),
      stopReason: z.string().optional(),
    })
    .strict();
}

export const ModelHealthStatusSchema = z
  .object({
    ok: z.boolean(),
    endpoint: z.string().url(),
    transport: z.enum(["rest", "sdk"]),
    durationMs: z.number().nonnegative(),
    apiVersion: z.string().optional(),
    authentication: z.enum([
      "disabled-or-optional",
      "token-accepted",
      "required",
      "rejected",
      "unknown",
    ]),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ModelHealthStatus = Omit<z.infer<typeof ModelHealthStatusSchema>, "error"> & {
  readonly error?: StructuredError;
};

export const AvailableModelSchema = z
  .object({
    logicalKey: z.string().trim().min(1).max(512),
    variantId: z.string().trim().min(1).max(512),
    displayName: z.string().trim().min(1).max(1_024),
    type: z.string().trim().min(1).max(128),
    format: z.string().trim().min(1).max(128).optional(),
    loaded: z.boolean().optional(),
    contextLength: z.number().int().positive().optional(),
    capabilities: z.array(z.string().trim().min(1).max(128)).max(128).default([]),
    source: z.string().trim().min(1).max(512).optional(),
    device: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export type AvailableModel = z.infer<typeof AvailableModelSchema>;

export const ResolvedModelSchema = z
  .object({
    requested: z.string().min(1),
    logicalKey: z.string().min(1),
    selectedVariantId: z.string().min(1),
    displayName: z.string().min(1),
    variants: z.array(AvailableModelSchema).min(1),
    matchType: z.enum(["exact-key", "exact-variant", "normalized"]),
    routingMetadataAvailable: z.boolean(),
  })
  .strict();

export type ResolvedModel = z.infer<typeof ResolvedModelSchema>;

export const LMStudioConnectionConfigSchema = z
  .object({
    baseUrl: z.string().max(2_048).url(),
    apiToken: z
      .string()
      .min(1)
      .max(8_192)
      .regex(/^[\x21-\x7e]+$/u)
      .optional(),
    requestedModel: z.string().trim().min(1).max(512),
    contextLength: z.number().int().min(1_024).max(1_048_576),
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().int().min(1).max(32_768),
    connectionTimeoutMs: z.number().int().min(1_000).max(300_000),
    resolutionTimeoutMs: z.number().int().min(1_000).max(300_000),
    loadTimeoutMs: z.number().int().min(1_000).max(1_800_000),
    predictionTimeoutMs: z.number().int().min(1_000).max(1_800_000),
    maxRetries: z.number().int().min(0).max(2),
    retryDelayMs: z.number().int().min(0).max(60_000),
  })
  .strict();

export type LMStudioConnectionConfig = z.infer<typeof LMStudioConnectionConfigSchema>;

export interface LocalModelClient {
  complete<T>(
    request: ModelCompletionRequest,
    outputSchema: ZodType<T>,
  ): Promise<ModelCompletionResponse<T>>;

  healthCheck(): Promise<ModelHealthStatus>;

  listModels(signal?: AbortSignal): Promise<readonly AvailableModel[]>;

  resolveModel(requestedModel: string, signal?: AbortSignal): Promise<ResolvedModel>;
}
