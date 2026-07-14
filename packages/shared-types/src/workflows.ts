import { z } from "zod";

import { AgentRunStatusSchema } from "./agents.js";
import { StructuredErrorSchema } from "./errors.js";
import { IdentifierSchema, IsoDateTimeSchema, JsonValueSchema } from "./json.js";
import { AgentTurnSchema } from "./tools.js";
import { ValidationFindingSchema } from "./tracing.js";

export const WorkflowModeSchema = z.enum(["plan-only", "dry-run", "apply"]);
export type WorkflowMode = z.infer<typeof WorkflowModeSchema>;

export const WorkflowStatusSchema = z.enum(["succeeded", "failed", "cancelled", "partial"]);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

export const WorkflowDefinitionSchema = z
  .object({
    id: IdentifierSchema,
    name: z.string().min(1).max(256),
    description: z.string().min(1).max(8_192),
    agentIds: z.array(IdentifierSchema).min(1).max(64),
    mutating: z.boolean(),
  })
  .strict();

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const ProcessResultSchema = z
  .object({
    commandId: IdentifierSchema,
    exitCode: z.number().int().nullable(),
    signal: z.string().min(1).max(128).nullable(),
    stdout: z.string().max(10_000_000),
    stderr: z.string().max(10_000_000),
    timedOut: z.boolean(),
    truncated: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    startedAt: IsoDateTimeSchema,
    endedAt: IsoDateTimeSchema,
  })
  .strict();

export type ProcessResult = z.infer<typeof ProcessResultSchema>;

export const ChangedFileSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    operation: z.enum(["create", "update", "delete"]),
    beforeSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    afterSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
  })
  .strict();

export const WorkflowResultSchema = z
  .object({
    workflowId: IdentifierSchema,
    runId: z.string().uuid(),
    status: WorkflowStatusSchema,
    mode: WorkflowModeSchema,
    summary: z.string().min(1).max(100_000),
    findings: z.array(ValidationFindingSchema).max(100_000).default([]),
    changedFiles: z.array(ChangedFileSchema).max(100_000).default([]),
    processResults: z.array(ProcessResultSchema).max(10_000).default([]),
    data: JsonValueSchema.optional(),
    error: StructuredErrorSchema.optional(),
    startedAt: IsoDateTimeSchema,
    endedAt: IsoDateTimeSchema,
  })
  .strict();

export type WorkflowResult = z.infer<typeof WorkflowResultSchema>;

export const AgentRunResultSchema = z
  .object({
    agentId: IdentifierSchema,
    status: AgentRunStatusSchema,
    turns: z.array(AgentTurnSchema).max(1_000),
    stepCount: z.number().int().nonnegative(),
    error: StructuredErrorSchema.optional(),
  })
  .strict();

export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;
