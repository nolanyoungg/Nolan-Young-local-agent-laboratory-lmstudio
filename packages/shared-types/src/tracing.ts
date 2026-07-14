import { z } from "zod";

import { StructuredErrorSchema } from "./errors.js";
import { IdentifierSchema, IsoDateTimeSchema, JsonObjectSchema } from "./json.js";
import { ModelIdentifierSchema, ModelProviderSchema } from "./models.js";
import { ToolCallSchema, ToolResultSchema } from "./tools.js";

export const SeveritySchema = z.enum(["debug", "info", "warning", "error", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const ValidationFindingSchema = z
  .object({
    severity: SeveritySchema,
    code: IdentifierSchema,
    message: z.string().min(1).max(16_384),
    path: z.string().min(1).max(1_024).optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    evidence: z.string().min(1).max(100_000).optional(),
  })
  .strict();

export type ValidationFinding = z.infer<typeof ValidationFindingSchema>;

export const RunMetadataSchema = z
  .object({
    runId: z.string().uuid(),
    application: IdentifierSchema,
    workflow: IdentifierSchema,
    startedAt: IsoDateTimeSchema,
    modelProvider: ModelProviderSchema,
    model: ModelIdentifierSchema,
    mode: z.enum(["plan-only", "dry-run", "apply"]),
  })
  .strict();

export type RunMetadata = z.infer<typeof RunMetadataSchema>;

export const WorkspaceMetadataSchema = z
  .object({
    root: z.string().min(1).max(32_768),
    name: z.string().min(1).max(512),
    canonical: z.boolean(),
    locked: z.boolean(),
  })
  .strict();

export type WorkspaceMetadata = z.infer<typeof WorkspaceMetadataSchema>;

const TraceEventBaseSchema = z.object({
  eventId: z.string().uuid(),
  runId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  timestamp: IsoDateTimeSchema,
});

export const TraceEventSchema = z.discriminatedUnion("type", [
  TraceEventBaseSchema.extend({
    type: z.literal("run.started"),
    payload: z.object({ run: RunMetadataSchema, workspace: WorkspaceMetadataSchema }).strict(),
  }).strict(),
  TraceEventBaseSchema.extend({
    type: z.literal("agent.started"),
    payload: z.object({ agentId: IdentifierSchema }).strict(),
  }).strict(),
  TraceEventBaseSchema.extend({
    type: z.literal("model.request"),
    payload: z.object({ requestId: z.string().uuid(), model: ModelIdentifierSchema }).strict(),
  }).strict(),
  TraceEventBaseSchema.extend({
    type: z.literal("model.response"),
    payload: z
      .object({
        requestId: z.string().uuid(),
        provider: ModelProviderSchema,
        durationMs: z.number().int().nonnegative(),
      })
      .strict(),
  }).strict(),
  TraceEventBaseSchema.extend({
    type: z.literal("tool.request"),
    payload: ToolCallSchema,
  }).strict(),
  TraceEventBaseSchema.extend({
    type: z.literal("tool.result"),
    payload: ToolResultSchema,
  }).strict(),
  TraceEventBaseSchema.extend({
    type: z.literal("workflow.completed"),
    payload: z
      .object({
        status: z.enum(["succeeded", "failed", "cancelled", "partial"]),
        summary: z.string().min(1).max(100_000),
      })
      .strict(),
  }).strict(),
  TraceEventBaseSchema.extend({
    type: z.literal("error"),
    payload: StructuredErrorSchema,
  }).strict(),
  TraceEventBaseSchema.extend({
    type: z.literal("custom"),
    payload: JsonObjectSchema,
  }).strict(),
]);

export type TraceEvent = z.infer<typeof TraceEventSchema>;
