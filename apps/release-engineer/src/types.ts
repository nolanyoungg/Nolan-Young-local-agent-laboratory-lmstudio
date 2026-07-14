import { z } from "zod";

export const ReleaseActionSchema = z.enum(["check", "prepare", "package", "release"]);
export type ReleaseAction = z.infer<typeof ReleaseActionSchema>;

export const ReleaseModeSchema = z.enum(["dry-run", "apply"]);
export type ReleaseMode = z.infer<typeof ReleaseModeSchema>;

export const ReleaseFindingSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/u),
    severity: z.enum(["error", "warning", "info"]),
    message: z.string().min(1).max(16_384),
    path: z.string().min(1).max(1_024).optional(),
  })
  .strict();

export type ReleaseFinding = z.infer<typeof ReleaseFindingSchema>;

export interface PackageMetadata {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
}

export interface ReleaseCheckResult {
  readonly passed: boolean;
  readonly findings: readonly ReleaseFinding[];
  readonly metadata?: PackageMetadata;
  readonly inspectedFiles: number;
}

export interface PackageManifestEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly source: "disk" | "overlay";
}

export interface PackageManifest {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly entries: readonly PackageManifestEntry[];
  readonly totalBytes: number;
}

export interface ArchiveInspectionEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly crc32: number;
}

export interface ArchiveInspection {
  readonly valid: true;
  readonly archivePath: string;
  readonly archiveBytes: number;
  readonly entries: readonly ArchiveInspectionEntry[];
}

export interface RepairAttempt {
  readonly pass: number;
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly checksPassedAfterAttempt: boolean;
}

export interface ReleaseWorkflowResult {
  readonly action: ReleaseAction;
  readonly mode: ReleaseMode;
  readonly status: "succeeded" | "failed";
  readonly summary: string;
  readonly runId: string;
  readonly runDirectory: string;
  readonly workspace: {
    readonly name: string;
    readonly identitySha256: string;
  };
  readonly checks: ReleaseCheckResult;
  readonly repairs: readonly RepairAttempt[];
  readonly manifest?: PackageManifest;
  readonly archive?: ArchiveInspection;
  readonly checksum?: string;
  readonly checksumPath?: string;
  readonly releaseNotesPath?: string;
}

export interface ReleasePolicies {
  readonly checks: CheckPolicy;
  readonly packaging: PackagePolicy;
  readonly permissions: PermissionPolicy;
  readonly protectedWorkspacePaths: readonly string[];
}

export interface CheckPolicy {
  readonly requiredPackageFields: readonly string[];
  readonly requiredFiles: readonly string[];
  readonly forbiddenGlobs: readonly string[];
}

export interface PackagePolicy {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly maximumEntries: number;
  readonly maximumArchiveBytes: number;
}

export interface PermissionPolicy {
  readonly repairer: readonly string[];
  readonly reviewer: readonly string[];
}

export type VirtualOverlay = ReadonlyMap<string, string>;
