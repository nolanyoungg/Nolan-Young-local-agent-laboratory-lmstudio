import { z } from "zod";

import { JsonObjectSchema } from "./json.js";

export const ErrorCategorySchema = z.enum([
  "configuration",
  "validation",
  "security",
  "filesystem",
  "process",
  "model",
  "workflow",
  "internal",
]);

export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

export const StructuredErrorSchema = z
  .object({
    name: z.string().min(1).max(128),
    code: z.string().min(1).max(128),
    category: ErrorCategorySchema,
    message: z.string().min(1).max(16_384),
    retryable: z.boolean().default(false),
    details: JsonObjectSchema.optional(),
    cause: z.string().min(1).max(16_384).optional(),
  })
  .strict();

export type StructuredError = z.infer<typeof StructuredErrorSchema>;

export function structuredErrorFromUnknown(
  error: unknown,
  fallback: Omit<StructuredError, "cause" | "details">,
): StructuredError {
  if (error instanceof Error) {
    return {
      ...fallback,
      cause: error.message,
    };
  }

  return fallback;
}
