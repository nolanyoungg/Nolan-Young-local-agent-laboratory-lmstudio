import { z } from "zod";

import { StructuredErrorSchema } from "./errors.js";
import { JsonValueSchema } from "./json.js";
import { ValidationFindingSchema } from "./tracing.js";

const RelativePathSchema = z.string().min(1).max(1_024);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/iu);
const CallIdSchema = z.string().min(1).max(128);

const action = <TTool extends string, TInput extends z.ZodTypeAny>(tool: TTool, input: TInput) =>
  z
    .object({
      kind: z.literal("tool_call"),
      callId: CallIdSchema,
      tool: z.literal(tool),
      input,
    })
    .strict();

export const AgentToolCallActionSchema = z.discriminatedUnion("tool", [
  action(
    "list_files",
    z
      .object({
        path: RelativePathSchema.default("."),
        recursive: z.boolean().default(true),
        maxResults: z.number().int().positive().max(2_000).default(2_000),
      })
      .strict(),
  ),
  action(
    "read_file",
    z
      .object({
        path: RelativePathSchema,
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
        maxOutputBytes: z.number().int().positive().max(131_072).optional(),
      })
      .strict(),
  ),
  action("read_file_metadata", z.object({ path: RelativePathSchema }).strict()),
  action(
    "search_text",
    z
      .object({
        path: RelativePathSchema.default("."),
        query: z.string().min(1).max(1_000),
        caseSensitive: z.boolean().default(false),
        maxResults: z.number().int().positive().max(200).default(200),
      })
      .strict(),
  ),
  action(
    "create_file",
    z.object({ path: RelativePathSchema, content: z.string().max(1_048_576) }).strict(),
  ),
  action(
    "write_file",
    z
      .object({
        path: RelativePathSchema,
        content: z.string().max(1_048_576),
        expectedSha256: Sha256Schema,
      })
      .strict(),
  ),
  action(
    "apply_patch",
    z
      .object({
        path: RelativePathSchema,
        patch: z.string().min(1).max(1_048_576),
        expectedSha256: Sha256Schema,
      })
      .strict(),
  ),
  action("run_command", z.object({ commandId: z.string().min(1).max(128) }).strict()),
  action("process_status", z.object({}).strict()),
  action(
    "process_logs",
    z
      .object({
        cursor: z.number().int().nonnegative().default(0),
        maximumBytes: z.number().int().positive().max(65_536).default(65_536),
      })
      .strict(),
  ),
]);

export type AgentToolCallAction = z.infer<typeof AgentToolCallActionSchema>;

export const CompletionEvidenceSchema = z
  .object({
    description: z.string().min(1).max(8_192),
    path: RelativePathSchema.optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    sha256: Sha256Schema.optional(),
  })
  .strict();

export const AgentCompleteActionSchema = z
  .object({
    kind: z.literal("complete"),
    summary: z.string().min(1).max(100_000),
    evidence: z.array(CompletionEvidenceSchema).max(2_000),
    findings: z.array(ValidationFindingSchema).max(2_000),
  })
  .strict();

export const AgentActionSchema = z.union([AgentToolCallActionSchema, AgentCompleteActionSchema]);

export type AgentAction = z.infer<typeof AgentActionSchema>;

const ToolResultMetadataSchema = z
  .object({
    callId: CallIdSchema,
    tool: z.string().min(1).max(64),
    durationMs: z.number().int().nonnegative(),
    cached: z.boolean(),
    replayed: z.boolean(),
    truncated: z.boolean(),
    returnedBytes: z.number().int().nonnegative(),
    originalBytes: z.number().int().nonnegative().optional(),
    beforeSha256: Sha256Schema.nullable().optional(),
    afterSha256: Sha256Schema.optional(),
  })
  .strict();

export const ToolExecutionSuccessSchema = ToolResultMetadataSchema.extend({
  status: z.literal("success"),
  output: JsonValueSchema,
}).strict();

export const ToolExecutionFailureSchema = ToolResultMetadataSchema.extend({
  status: z.enum(["rejected", "error"]),
  error: StructuredErrorSchema,
}).strict();

export const ToolExecutionResultSchema = z.union([
  ToolExecutionSuccessSchema,
  ToolExecutionFailureSchema,
]);

export type ToolExecutionContract = z.infer<typeof ToolExecutionResultSchema>;
