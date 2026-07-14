import path from "node:path";

import type { LocalModelClient } from "@local-agent-lab/local-model-client";
import {
  JsonlTraceWriter,
  ReportWriter,
  RunDirectoryManager,
  TraceRecorder,
  sanitizedError,
  type RunDirectory,
} from "@local-agent-lab/tracing";
import {
  WorkspaceGuard,
  isPathInside,
  withWorkspaceLock,
} from "@local-agent-lab/workspace-security";

import { ArchiveInspector, DeterministicZipWriter } from "./DeterministicZip.js";
import { ReleaseEngineerError } from "./errors.js";
import { sha256Bytes, sha256File } from "./hash.js";
import {
  PackageManifestBuilder,
  serializableManifest,
  type BuiltPackageManifest,
} from "./PackageManifestBuilder.js";
import { ReleaseChecker } from "./ReleaseChecker.js";
import { ReleaseRepairer, type MutationJournalEntry } from "./ReleaseRepairer.js";
import type {
  ReleaseAction,
  ReleaseCheckResult,
  ReleaseMode,
  ReleasePolicies,
  ReleaseWorkflowResult,
  RepairAttempt,
  VirtualOverlay,
} from "./types.js";
import { WorkspaceSnapshot } from "./WorkspaceSnapshot.js";

export interface ReleaseEngineerWorkflowOptions {
  readonly action: ReleaseAction;
  readonly mode: ReleaseMode;
  readonly workspace: string;
  readonly reportsRoot: string;
  readonly policies: ReleasePolicies;
  readonly repair: boolean;
  readonly maximumRepairPasses?: number;
  readonly operatorTask?: string;
  readonly modelClient?: LocalModelClient;
  readonly requestedModel?: string;
  readonly signal?: AbortSignal;
  readonly runDirectoryManager?: RunDirectoryManager;
}

function relativeProtectedPath(root: string, absolutePath: string): string | undefined {
  const relative = path.relative(path.resolve(root), path.resolve(absolutePath));
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return relative.replaceAll("\\", "/");
}

function assertNotInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ReleaseEngineerError(
      "INTERRUPTED",
      "Release workflow was interrupted.",
      "interrupted",
    );
  }
}

function workspaceDescriptor(workspaceRoot: string): ReleaseWorkflowResult["workspace"] {
  const identity = process.platform === "win32" ? workspaceRoot.toLowerCase() : workspaceRoot;
  return {
    name: path.basename(workspaceRoot),
    identitySha256: sha256Bytes(identity),
  };
}

function markdownText(value: string): string {
  return value.replaceAll("|", "\\|").replace(/[\r\n]+/gu, " ");
}

function finalReport(result: ReleaseWorkflowResult): string {
  const lines = [
    "# Release Engineer Final Report",
    "",
    `- Action: \`${result.action}\``,
    `- Mode: \`${result.mode}\``,
    `- Status: **${result.status.toUpperCase()}**`,
    `- Run: \`${result.runId}\``,
    `- Summary: ${markdownText(result.summary)}`,
    "",
    "## Deterministic checks",
    "",
    `Checks ${result.checks.passed ? "passed" : "failed"}; ${result.checks.inspectedFiles} regular files were inspected.`,
    "",
  ];
  if (result.checks.findings.length === 0) {
    lines.push("No findings.", "");
  } else {
    lines.push("| Severity | Code | Path | Finding |", "| --- | --- | --- | --- |");
    for (const finding of result.checks.findings) {
      lines.push(
        `| ${finding.severity} | ${finding.code} | ${markdownText(finding.path ?? "—")} | ${markdownText(finding.message)} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Packaging", "");
  if (result.manifest === undefined) {
    lines.push("Packaging was not executed.", "");
  } else {
    lines.push(
      `Validated manifest: ${result.manifest.entries.length} entries, ${result.manifest.totalBytes} bytes.`,
      result.archive === undefined
        ? "No archive was emitted (dry-run)."
        : `Validated archive: \`${path.basename(result.archive.archivePath)}\` (${result.archive.archiveBytes} bytes).`,
      result.checksum === undefined
        ? "No checksum artifact was emitted."
        : `SHA-256: \`${result.checksum}\``,
      "",
    );
  }
  if (result.repairs.length > 0) {
    lines.push("## Repair passes", "");
    for (const attempt of result.repairs) {
      lines.push(
        `- Pass ${attempt.pass}: ${markdownText(attempt.summary)} Deterministic checks ${attempt.checksPassedAfterAttempt ? "passed" : "failed"}.`,
      );
    }
    lines.push("");
  }
  lines.push(
    "Deterministic checks alone decide release readiness. This application did not publish, tag, commit, push, or create a hosted release.",
    "",
  );
  return lines.join("\n");
}

function releaseNotes(
  checks: ReleaseCheckResult,
  build: BuiltPackageManifest,
  archiveName: string | undefined,
  checksum: string | undefined,
  dryRun: boolean,
): string {
  const metadata = checks.metadata;
  if (metadata === undefined) {
    throw new ReleaseEngineerError(
      "PACKAGE_METADATA_MISSING",
      "Validated package metadata is unavailable for release notes.",
      "workflow",
    );
  }
  const lines = [
    `# ${metadata.name} ${metadata.version}`,
    "",
    metadata.description ?? "No package description was provided.",
    "",
    "## Validated release facts",
    "",
    `- Deterministic checks: passed`,
    `- Manifest entries: ${build.manifest.entries.length}`,
    `- Manifest bytes: ${build.manifest.totalBytes}`,
    dryRun ? "- Archive: not emitted (dry-run)" : `- Archive: ${archiveName ?? "unavailable"}`,
    dryRun ? "- SHA-256: not emitted (dry-run)" : `- SHA-256: ${checksum ?? "unavailable"}`,
    "",
    "## Included paths",
    "",
    ...build.manifest.entries.slice(0, 500).map((entry) => `- \`${entry.path}\``),
  ];
  if (build.manifest.entries.length > 500) {
    lines.push(`- …and ${build.manifest.entries.length - 500} additional validated entries`);
  }
  lines.push("");
  return lines.join("\n");
}

export class ReleaseEngineerWorkflow {
  #mutationJournal: readonly MutationJournalEntry[] = [];

  public constructor(private readonly options: ReleaseEngineerWorkflowOptions) {}

  public async run(): Promise<ReleaseWorkflowResult> {
    this.#mutationJournal = [];
    const maximumRepairPasses = this.options.maximumRepairPasses ?? 3;
    if (
      !Number.isSafeInteger(maximumRepairPasses) ||
      maximumRepairPasses < 0 ||
      maximumRepairPasses > 3
    ) {
      throw new ReleaseEngineerError(
        "INVALID_REPAIR_LIMIT",
        "maximumRepairPasses must be an integer from 0 through 3.",
        "configuration",
      );
    }
    if (this.options.repair && this.options.modelClient === undefined) {
      throw new ReleaseEngineerError(
        "MODEL_CLIENT_REQUIRED",
        "Repair was requested without an explicit model client.",
        "configuration",
      );
    }
    assertNotInterrupted(this.options.signal);

    const requestedWorkspace = path.resolve(this.options.workspace);
    const protectedGlobs = this.options.policies.protectedWorkspacePaths
      .map((policyPath) => relativeProtectedPath(requestedWorkspace, policyPath))
      .filter((relativePath): relativePath is string => relativePath !== undefined);
    const workspaceGuard = await WorkspaceGuard.create(requestedWorkspace, {
      forbiddenGlobs: protectedGlobs,
    });
    const requestedReportsRoot = path.resolve(this.options.reportsRoot);
    if (isPathInside(workspaceGuard.root, requestedReportsRoot)) {
      throw new ReleaseEngineerError(
        "REPORT_ROOT_IN_WORKSPACE",
        "The trusted report root must be outside the target workspace.",
        "security",
      );
    }

    const runManager =
      this.options.runDirectoryManager ?? new RunDirectoryManager(requestedReportsRoot);
    const run = await runManager.create({
      application: "release-engineer",
      workspaceRoot: workspaceGuard.root,
      modelProvider: this.options.repair ? "explicit-local-model" : "none",
      requestedModel: this.options.requestedModel ?? "not-required",
      mode: this.options.mode,
    });
    const reportWriter = new ReportWriter();
    await reportWriter.writeJson(run.metadataPath, {
      runId: run.runId,
      application: "release-engineer",
      reportDirectory: path.basename(run.path),
      workspace: workspaceDescriptor(workspaceGuard.root),
      modelProvider: this.options.repair ? "explicit-local-model" : "none",
      requestedModel: this.options.requestedModel ?? "not-required",
      mode: this.options.mode,
      processId: process.pid,
      nodeVersion: process.version,
    });
    const trace = new TraceRecorder(new JsonlTraceWriter(run.tracePath));
    let lastChecks: ReleaseCheckResult = {
      passed: false,
      findings: [],
      inspectedFiles: 0,
    };

    try {
      await trace.record({
        type: "workflow",
        status: "started",
        runId: run.runId,
        metadata: { action: this.options.action, mode: this.options.mode },
      });
      return await withWorkspaceLock(
        {
          workspaceRoot: workspaceGuard.root,
          trustedLockRoot: path.join(path.dirname(run.path), ".locks"),
        },
        async () => {
          const result = await this.#execute(run, workspaceGuard, trace, reportWriter, (checks) => {
            lastChecks = checks;
          });
          await trace.record({
            type: "workflow",
            status: result.status === "succeeded" ? "completed" : "failed",
            runId: run.runId,
            metadata: {
              action: result.action,
              checksPassed: result.checks.passed,
              archiveEmitted: result.archive !== undefined,
            },
          });
          await reportWriter.writeJson(run.finalResultPath, result);
          await reportWriter.writeText(run.finalReportPath, finalReport(result));
          return result;
        },
      );
    } catch (error) {
      await trace
        .recordError(
          { type: "workflow", runId: run.runId, metadata: { action: this.options.action } },
          error,
        )
        .catch(() => undefined);
      await reportWriter
        .writeJson(run.finalResultPath, {
          action: this.options.action,
          mode: this.options.mode,
          status: "failed",
          runId: run.runId,
          checks: lastChecks,
          error: sanitizedError(error),
        })
        .catch(() => undefined);
      await reportWriter
        .writeText(
          run.finalReportPath,
          [
            "# Release Engineer Final Report",
            "",
            "Status: **FAILED**",
            "",
            `The workflow stopped with sanitized error code \`${sanitizedError(error).code ?? "UNKNOWN"}\`.`,
            "",
          ].join("\n"),
        )
        .catch(() => undefined);
      if (error instanceof ReleaseEngineerError) throw error;
      const category =
        error instanceof Error && error.name === "ModelClientError" ? "model" : "infrastructure";
      throw new ReleaseEngineerError(
        category === "model" ? "MODEL_UNAVAILABLE" : "WORKFLOW_INFRASTRUCTURE_FAILED",
        category === "model"
          ? "The explicitly selected local model was unavailable."
          : "Release workflow infrastructure failed.",
        category,
        { cause: error },
      );
    } finally {
      try {
        await reportWriter.writeJson(path.join(run.path, "mutation-journal.json"), {
          version: 1,
          mutations: this.#mutationJournal,
        });
      } finally {
        await trace.close();
      }
    }
  }

  async #execute(
    run: RunDirectory,
    workspaceGuard: WorkspaceGuard,
    trace: TraceRecorder,
    reportWriter: ReportWriter,
    setChecks: (checks: ReleaseCheckResult) => void,
  ): Promise<ReleaseWorkflowResult> {
    const checker = new ReleaseChecker(this.options.policies.checks);
    let overlay: VirtualOverlay = new Map();
    let checks = await trace.measure({ type: "deterministic_checks", runId: run.runId }, async () =>
      checker.check(new WorkspaceSnapshot(workspaceGuard.root, overlay)),
    );
    setChecks(checks);
    const repairs: RepairAttempt[] = [];

    const mayRepair =
      this.options.repair &&
      (this.options.action === "prepare" || this.options.action === "release");
    if (!checks.passed && mayRepair) {
      const repairer = new ReleaseRepairer({
        runId: run.runId,
        workspaceGuard,
        mode: this.options.mode,
        permissions: this.options.policies.permissions,
        modelClient: this.options.modelClient as LocalModelClient,
        requestedModel: this.options.requestedModel ?? "qwen/qwen2.5-coder-14b",
        trace,
        operatorTask:
          this.options.operatorTask ?? "Repair the deterministic release-readiness findings.",
        ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
      });
      try {
        for (let pass = 1; pass <= (this.options.maximumRepairPasses ?? 3); pass += 1) {
          assertNotInterrupted(this.options.signal);
          const repaired = await repairer.run(pass, checks.findings);
          overlay = repaired.overlay;
          checks = await checker.check(new WorkspaceSnapshot(workspaceGuard.root, overlay));
          setChecks(checks);
          repairs.push({
            pass,
            summary: repaired.summary,
            changedFiles: repaired.mutationPaths,
            checksPassedAfterAttempt: checks.passed,
          });
          if (checks.passed) break;
        }
      } finally {
        this.#mutationJournal = repairer.mutationJournal;
      }
    }

    await reportWriter.writeJson(run.diagnosticsPath, {
      status: repairs.length === 0 ? "SKIPPED" : "USED",
      reason:
        repairs.length === 0
          ? "Deterministic workflow did not require inference."
          : "Explicit repair requested.",
      requestedModel: repairs.length === 0 ? undefined : this.options.requestedModel,
    });
    await reportWriter.writeJson(path.join(run.path, "checks.json"), checks);

    if (!checks.passed) {
      return {
        action: this.options.action,
        mode: this.options.mode,
        status: "failed",
        summary: "Deterministic release checks failed.",
        runId: run.runId,
        runDirectory: path.basename(run.path),
        workspace: workspaceDescriptor(workspaceGuard.root),
        checks,
        repairs,
      };
    }
    if (this.options.action === "check" || this.options.action === "prepare") {
      return {
        action: this.options.action,
        mode: this.options.mode,
        status: "succeeded",
        summary:
          this.options.mode === "dry-run" && repairs.length > 0
            ? "Planned repairs satisfy deterministic checks in the virtual overlay; the workspace is unchanged."
            : "Deterministic release checks passed.",
        runId: run.runId,
        runDirectory: path.basename(run.path),
        workspace: workspaceDescriptor(workspaceGuard.root),
        checks,
        repairs,
      };
    }

    assertNotInterrupted(this.options.signal);
    const metadata = checks.metadata;
    if (metadata === undefined) {
      throw new ReleaseEngineerError(
        "PACKAGE_METADATA_MISSING",
        "Passing checks did not yield validated package metadata.",
        "workflow",
      );
    }
    const snapshot = new WorkspaceSnapshot(workspaceGuard.root, overlay);
    const build = await new PackageManifestBuilder(
      this.options.policies.packaging,
      workspaceGuard,
    ).build(snapshot, metadata);
    await reportWriter.writeJson(
      path.join(run.path, "package-manifest.json"),
      serializableManifest(build.manifest),
    );

    if (this.options.mode === "dry-run") {
      let releaseNotesPath: string | undefined;
      if (this.options.action === "release") {
        const releaseNotesAbsolutePath = path.join(run.path, "release-notes.md");
        await reportWriter.writeText(
          releaseNotesAbsolutePath,
          releaseNotes(checks, build, undefined, undefined, true),
        );
        releaseNotesPath = "release-notes.md";
      }
      return {
        action: this.options.action,
        mode: this.options.mode,
        status: "succeeded",
        summary:
          "The planned package manifest passed validation; no ZIP or checksum artifact was emitted.",
        runId: run.runId,
        runDirectory: path.basename(run.path),
        workspace: workspaceDescriptor(workspaceGuard.root),
        checks,
        repairs,
        manifest: build.manifest,
        ...(releaseNotesPath === undefined ? {} : { releaseNotesPath }),
      };
    }

    const archivePath = await trace.measure({ type: "archive_write", runId: run.runId }, async () =>
      new DeterministicZipWriter(workspaceGuard).write(build, run.artifactsPath),
    );
    const forbiddenArchiveGlobs = [
      ...this.options.policies.checks.forbiddenGlobs,
      ...this.options.policies.packaging.exclude,
    ];
    const inspectedArchive = await trace.measure(
      { type: "archive_inspection", runId: run.runId },
      async () =>
        new ArchiveInspector().inspect(archivePath, build.manifest, forbiddenArchiveGlobs),
    );
    if (inspectedArchive.archiveBytes > this.options.policies.packaging.maximumArchiveBytes) {
      throw new ReleaseEngineerError(
        "ARCHIVE_SIZE_LIMIT",
        `Generated ZIP exceeds ${this.options.policies.packaging.maximumArchiveBytes} bytes.`,
        "workflow",
      );
    }
    const archive = {
      ...inspectedArchive,
      archivePath: `artifacts/${path.basename(inspectedArchive.archivePath)}`,
    };
    await reportWriter.writeJson(path.join(run.path, "archive-inspection.json"), {
      ...archive,
    });

    let checksum: string | undefined;
    let checksumPath: string | undefined;
    let releaseNotesPath: string | undefined;
    if (this.options.action === "release") {
      checksum = await sha256File(archivePath);
      const checksumAbsolutePath = `${archivePath}.sha256`;
      await reportWriter.writeText(
        checksumAbsolutePath,
        `${checksum}  ${path.basename(archivePath)}\n`,
      );
      checksumPath = `artifacts/${path.basename(checksumAbsolutePath)}`;
      const releaseNotesAbsolutePath = path.join(run.path, "release-notes.md");
      await reportWriter.writeText(
        releaseNotesAbsolutePath,
        releaseNotes(checks, build, path.basename(archivePath), checksum, false),
      );
      releaseNotesPath = "release-notes.md";
    }

    return {
      action: this.options.action,
      mode: this.options.mode,
      status: "succeeded",
      summary:
        this.options.action === "package"
          ? "Deterministic package archive was created and validated."
          : "Release archive, checksum, inspection, and factual release notes were created and validated.",
      runId: run.runId,
      runDirectory: path.basename(run.path),
      workspace: workspaceDescriptor(workspaceGuard.root),
      checks,
      repairs,
      manifest: build.manifest,
      archive,
      ...(checksum === undefined ? {} : { checksum }),
      ...(checksumPath === undefined ? {} : { checksumPath }),
      ...(releaseNotesPath === undefined ? {} : { releaseNotesPath }),
    };
  }
}
