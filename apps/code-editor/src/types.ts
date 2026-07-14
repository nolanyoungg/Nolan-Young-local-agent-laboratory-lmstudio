import { z } from "zod";

export const CodeEditorModeSchema = z.enum(["plan-only", "dry-run", "apply"]);
export type CodeEditorMode = z.infer<typeof CodeEditorModeSchema>;

export const CliExitCode = {
  success: 0,
  workflowFailure: 1,
  usage: 2,
  infrastructure: 3,
  interrupted: 130,
} as const;

export type CodeEditorExitCode = (typeof CliExitCode)[keyof typeof CliExitCode];

const EvidenceSchema = z.array(z.string().min(1).max(4_096)).max(100);
const FindingTextSchema = z.array(z.string().min(1).max(8_192)).max(100);

export const PlanItemSchema = z
  .object({
    action: z.string().min(1).max(8_192),
    path: z.string().min(1).max(1_024).optional(),
    rationale: z.string().min(1).max(8_192),
    acceptanceCriteria: z.array(z.string().min(1).max(4_096)).max(32),
  })
  .strict();

export const PlannerFinalSchema = z
  .object({
    summary: z.string().min(1).max(32_768),
    evidence: EvidenceSchema,
    findings: FindingTextSchema,
    changePlan: z.array(PlanItemSchema).max(100),
  })
  .strict();

export type PlannerFinal = z.infer<typeof PlannerFinalSchema>;

export const EditorFinalSchema = z
  .object({
    summary: z.string().min(1).max(32_768),
    evidence: EvidenceSchema,
    findings: FindingTextSchema,
    changedFiles: z.array(z.string().min(1).max(1_024)).max(2_000),
  })
  .strict();

export type EditorFinal = z.infer<typeof EditorFinalSchema>;

export const ReviewFindingSchema = z
  .object({
    severity: z.enum(["info", "warning", "error"]),
    message: z.string().min(1).max(8_192),
    evidence: EvidenceSchema,
  })
  .strict();

export const ReviewerFinalSchema = z
  .object({
    summary: z.string().min(1).max(32_768),
    evidence: EvidenceSchema,
    findings: z.array(ReviewFindingSchema).max(100),
    approved: z.boolean(),
    requiredChanges: z.array(z.string().min(1).max(8_192)).max(100),
  })
  .strict();

export type ReviewerFinal = z.infer<typeof ReviewerFinalSchema>;

export const PermissionsSchema = z
  .object({
    planner: z.array(z.string().min(1)).min(1),
    editor: z.array(z.string().min(1)).min(1),
    reviewer: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type RolePermissions = z.infer<typeof PermissionsSchema>;

export const EditPolicySchema = z
  .object({
    version: z.literal(1),
    readAllow: z.array(z.string().min(1)).min(1),
    writeAllow: z.array(z.string().min(1)).min(1),
    deny: z.array(z.string().min(1)),
    maximumFileBytes: z.number().int().positive().max(1_048_576),
    maximumOutputBytes: z.number().int().positive().max(131_072),
    maximumFiles: z.number().int().positive().max(2_000),
    maximumSearchMatches: z.number().int().positive().max(200),
  })
  .strict();

export type EditPolicy = z.infer<typeof EditPolicySchema>;
