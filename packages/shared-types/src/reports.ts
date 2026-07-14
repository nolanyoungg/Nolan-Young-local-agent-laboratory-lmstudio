import { z } from "zod";

import { StructuredErrorSchema } from "./errors.js";
import { IsoDateTimeSchema, JsonValueSchema } from "./json.js";
import { ValidationFindingSchema } from "./tracing.js";
import { ChangedFileSchema, WorkflowModeSchema, WorkflowStatusSchema } from "./workflows.js";

export const ReportArtifactSchema = z
  .object({
    name: z.string().min(1).max(256),
    relativePath: z.string().min(1).max(1_024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/iu),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

export const FinalReportSchema = z
  .object({
    runId: z.string().uuid(),
    application: z.enum(["code-editor", "build-assistant", "release-engineer"]),
    status: WorkflowStatusSchema,
    mode: WorkflowModeSchema,
    summary: z.string().min(1).max(100_000),
    startedAt: IsoDateTimeSchema,
    endedAt: IsoDateTimeSchema,
    findings: z.array(ValidationFindingSchema).max(10_000).default([]),
    changedFiles: z.array(ChangedFileSchema).max(10_000).default([]),
    artifacts: z.array(ReportArtifactSchema).max(10_000).default([]),
    data: JsonValueSchema.optional(),
    error: StructuredErrorSchema.optional(),
  })
  .strict();

export type FinalReport = z.infer<typeof FinalReportSchema>;
