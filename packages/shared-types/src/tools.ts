import { z } from "zod";

import { StructuredErrorSchema } from "./errors.js";
import { IdentifierSchema, JsonObjectSchema, JsonValueSchema } from "./json.js";

export const ToolNameSchema = z.enum([
  "list_files",
  "read_file",
  "read_file_metadata",
  "search_text",
  "create_file",
  "write_file",
  "apply_patch",
  "run_command",
  "process_status",
  "process_logs",
]);

export type ToolName = z.infer<typeof ToolNameSchema>;

const RelativePathInputSchema = z.string().min(1).max(1_024);
const ToolCallIdSchema = z.string().uuid();

export const ListFilesToolCallSchema = z
  .object({
    id: ToolCallIdSchema,
    name: z.literal("list_files"),
    arguments: z
      .object({
        path: RelativePathInputSchema.default("."),
        pattern: z.string().min(1).max(1_024).optional(),
        maxResults: z.number().int().positive().max(10_000).default(2_000),
      })
      .strict(),
  })
  .strict();

export const ReadFileToolCallSchema = z
  .object({
    id: ToolCallIdSchema,
    name: z.literal("read_file"),
    arguments: z
      .object({
        path: RelativePathInputSchema,
        maxBytes: z.number().int().positive().max(10_000_000).optional(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (
          value.startLine !== undefined &&
          value.endLine !== undefined &&
          value.endLine < value.startLine
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "endLine must be greater than or equal to startLine",
            path: ["endLine"],
          });
        }
      }),
  })
  .strict();

export const ReadFileMetadataToolCallSchema = z
  .object({
    id: ToolCallIdSchema,
    name: z.literal("read_file_metadata"),
    arguments: z.object({ path: RelativePathInputSchema }).strict(),
  })
  .strict();

export const SearchTextToolCallSchema = z
  .object({
    id: ToolCallIdSchema,
    name: z.literal("search_text"),
    arguments: z
      .object({
        query: z.string().min(1).max(8_192),
        path: RelativePathInputSchema.default("."),
        pattern: z.string().min(1).max(1_024).optional(),
        caseSensitive: z.boolean().default(false),
        maxMatches: z.number().int().positive().max(10_000).default(200),
      })
      .strict(),
  })
  .strict();

const FileContentSchema = z.string().max(10_000_000);

export const CreateFileToolCallSchema = z
  .object({
    id: ToolCallIdSchema,
    name: z.literal("create_file"),
    arguments: z
      .object({
        path: RelativePathInputSchema,
        content: FileContentSchema,
      })
      .strict(),
  })
  .strict();

export const WriteFileToolCallSchema = z
  .object({
    id: ToolCallIdSchema,
    name: z.literal("write_file"),
    arguments: z
      .object({
        path: RelativePathInputSchema,
        content: FileContentSchema,
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i),
      })
      .strict(),
  })
  .strict();

export const ApplyPatchToolCallSchema = z
  .object({
    id: ToolCallIdSchema,
    name: z.literal("apply_patch"),
    arguments: z
      .object({
        path: RelativePathInputSchema,
        patch: z.string().min(1).max(10_000_000),
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i),
      })
      .strict(),
  })
  .strict();

export const RunCommandToolCallSchema = z
  .object({
    id: ToolCallIdSchema,
    name: z.literal("run_command"),
    arguments: z.object({ commandId: IdentifierSchema }).strict(),
  })
  .strict();

export const ToolCallSchema = z.discriminatedUnion("name", [
  ListFilesToolCallSchema,
  ReadFileToolCallSchema,
  ReadFileMetadataToolCallSchema,
  SearchTextToolCallSchema,
  CreateFileToolCallSchema,
  WriteFileToolCallSchema,
  ApplyPatchToolCallSchema,
  RunCommandToolCallSchema,
]);

export type ToolCall = z.infer<typeof ToolCallSchema>;
export const ToolRequestSchema = ToolCallSchema;
export type ToolRequest = ToolCall;

export const ToolDefinitionSchema = z
  .object({
    name: ToolNameSchema,
    description: z.string().min(1).max(8_192),
    mutating: z.boolean(),
    inputSchema: JsonObjectSchema,
    outputSchema: JsonObjectSchema.optional(),
  })
  .strict();

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ToolSuccessResultSchema = z
  .object({
    status: z.literal("success"),
    callId: ToolCallIdSchema,
    toolName: ToolNameSchema,
    output: JsonValueSchema,
    durationMs: z.number().int().nonnegative(),
    truncated: z.boolean().default(false),
  })
  .strict();

export const ToolErrorResultSchema = z
  .object({
    status: z.literal("error"),
    callId: ToolCallIdSchema,
    toolName: ToolNameSchema,
    error: StructuredErrorSchema,
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

export const ToolResultSchema = z.discriminatedUnion("status", [
  ToolSuccessResultSchema,
  ToolErrorResultSchema,
]);

export type ToolResult = z.infer<typeof ToolResultSchema>;

export const AgentTurnSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("assistant"),
      content: z.string().min(1).max(1_000_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool_calls"),
      calls: z.array(ToolCallSchema).min(1).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool_results"),
      results: z.array(ToolResultSchema).min(1).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal("final"),
      summary: z.string().min(1).max(100_000),
      result: JsonValueSchema.optional(),
    })
    .strict(),
]);

export type AgentTurn = z.infer<typeof AgentTurnSchema>;
