import { z } from "zod";

export const BuildModeSchema = z.enum(["dry-run", "apply"]);
export type BuildMode = z.infer<typeof BuildModeSchema>;

export const WatcherPolicySchema = z
  .object({
    readyPatterns: z.array(z.string().min(1).max(512)).max(64).default([]),
    successPatterns: z.array(z.string().min(1).max(512)).max(64).default([]),
    failurePatterns: z.array(z.string().min(1).max(512)).max(64).default([]),
    settleMs: z.number().int().min(50).max(30_000).default(750),
  })
  .strict();

export type WatcherPolicy = z.infer<typeof WatcherPolicySchema>;

export interface ProcessObservation {
  readonly commandId: string;
  readonly kind: "one-shot" | "watcher";
  readonly status: "failed" | "succeeded";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdoutDelta: string;
  readonly stderrDelta: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
  readonly matchedPattern?: string;
}

export interface FileChangeRecord {
  readonly pass: number;
  readonly role: "repairer";
  readonly callId: string;
  readonly tool: "apply_patch" | "create_file" | "write_file";
  readonly fingerprint: string;
  readonly path: string;
  readonly operation: "create" | "update";
  readonly beforeSha256: string | null;
  readonly afterSha256: string;
  readonly bytes: number;
  readonly dryRun: boolean;
}

export interface DiagnosisRecord {
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly findings: readonly string[];
  readonly likelyFiles: readonly string[];
}

export interface RepairRecord {
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly findings: readonly string[];
  readonly changedFiles: readonly string[];
}

export interface ReviewRecord {
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly findings: readonly string[];
  readonly approved: boolean;
}

export interface BuildPassRecord {
  readonly pass: number;
  readonly diagnosis: DiagnosisRecord;
  readonly repair: RepairRecord;
  readonly verification?: ProcessObservation;
  readonly review?: ReviewRecord;
}

export type BuildFinalStatus =
  | "initial-command-succeeded"
  | "repair-proposed-verification-not-executed"
  | "unresolved"
  | "verified";

export interface BuildAssistantResult {
  readonly status: "failed" | "succeeded";
  readonly finalStatus: BuildFinalStatus;
  readonly summary: string;
  readonly mode: BuildMode;
  readonly commandId: string;
  readonly runId: string;
  readonly runDirectory: string;
  readonly workspace: string;
  readonly watcher: boolean;
  readonly initial: ProcessObservation;
  readonly passes: readonly BuildPassRecord[];
  readonly changedFiles: readonly FileChangeRecord[];
}
