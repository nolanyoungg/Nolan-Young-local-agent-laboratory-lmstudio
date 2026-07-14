import { createHash } from "node:crypto";
import path from "node:path";

import {
  AgentRunner,
  RetryPolicy,
  type AgentDefinition,
  type RuntimeModelClient,
} from "@local-agent-lab/agent-runtime";
import { createLocalModelClient, ModelClientError } from "@local-agent-lab/local-model-client";
import { ProcessManager, type WatcherHandle } from "@local-agent-lab/process-tools";
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
  WorkspaceLock,
  type WorkspaceLock as WorkspaceLockHandle,
} from "@local-agent-lab/workspace-security";
import { z } from "zod";

import {
  loadCommandPolicy,
  loadRolePermissions,
  loadSystemPrompt,
  resolveApplicationLocations,
  type ApplicationLocations,
  type RolePermissions,
} from "./config.js";
import { BuildAssistantError, asBuildAssistantError } from "./errors.js";
import { BuildAssistantMockModelClient, LocalRuntimeModelAdapter } from "./model.js";
import {
  logMetadata,
  observeOneShot,
  observeWatcher,
  type LogOffsets,
} from "./process-observer.js";
import { createBuildToolRegistry, ProcessContext } from "./tools.js";
import type {
  BuildAssistantResult,
  BuildMode,
  BuildPassRecord,
  DiagnosisRecord,
  FileChangeRecord,
  ProcessObservation,
  RepairRecord,
  ReviewRecord,
  WatcherPolicy,
} from "./types.js";

const MAX_REPAIR_PASSES = 3;
const DEFAULT_MODEL = "qwen/qwen2.5-coder-14b";

const CommonFinalSchema = z.object({
  summary: z.string().min(1).max(32_768),
  evidence: z.array(z.string().min(1).max(8_192)).max(128),
  findings: z.array(z.string().min(1).max(8_192)).max(128),
});
const DiagnosisFinalSchema = CommonFinalSchema.extend({
  likelyFiles: z.array(z.string().min(1).max(1_024)).max(64),
}).strict();
const RepairFinalSchema = CommonFinalSchema.extend({
  changedFiles: z.array(z.string().min(1).max(1_024)).max(64),
}).strict();
const ReviewFinalSchema = CommonFinalSchema.extend({ approved: z.boolean() }).strict();

type DiagnosisFinal = z.infer<typeof DiagnosisFinalSchema> & Readonly<Record<string, unknown>>;
type RepairFinal = z.infer<typeof RepairFinalSchema> & Readonly<Record<string, unknown>>;
type ReviewFinal = z.infer<typeof ReviewFinalSchema> & Readonly<Record<string, unknown>>;

export interface BuildAssistantWorkflowOptions {
  readonly workspace: string;
  readonly commandId: string;
  readonly mode: BuildMode;
  readonly reportsRoot?: string;
  readonly commandConfigurationPath?: string;
  readonly requestedModel?: string;
  readonly mock?: boolean;
  readonly signal?: AbortSignal;
}

export interface BuildAssistantWorkflowDependencies {
  readonly locations?: ApplicationLocations;
  readonly runtimeModelClient?: RuntimeModelClient;
  readonly processManagerFactory?: (
    allowlist: ConstructorParameters<typeof ProcessManager>[0],
  ) => ProcessManager;
}

interface RoleContext {
  readonly runner: AgentRunner;
  readonly runtimeModelClient: RuntimeModelClient;
  readonly permissions: RolePermissions;
  readonly prompts: Readonly<{
    diagnostician: string;
    repairer: string;
    reviewer: string;
  }>;
  readonly model: string;
  readonly runId: string;
  readonly dryRun: boolean;
  readonly registry: ReturnType<typeof createBuildToolRegistry>["registry"];
  readonly trace: TraceRecorder;
}

interface ProcessRuntime {
  readonly manager: ProcessManager;
  readonly context: ProcessContext;
  readonly watcher?: WatcherHandle;
  readonly watcherPolicy?: WatcherPolicy;
  readonly timeoutMs: number;
  offsets: LogOffsets;
}

function relativeProtectedPath(workspaceRoot: string, candidate: string): string | undefined {
  const relative = path.relative(workspaceRoot, candidate);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.replaceAll("\\", "/");
}

function assertReportsOutsideWorkspace(workspaceRoot: string, reportsRoot: string): void {
  const relative = path.relative(workspaceRoot, reportsRoot);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new BuildAssistantError(
      "REPORT_ROOT_INSIDE_WORKSPACE",
      "The trusted report root must be outside the target workspace.",
      "configuration",
    );
  }
}

function modelRetryable(error: unknown): boolean {
  return error instanceof ModelClientError && error.retryable;
}

function processTask(observation: ProcessObservation): string {
  return JSON.stringify({
    commandId: observation.commandId,
    status: observation.status,
    exitCode: observation.exitCode,
    timedOut: observation.timedOut,
    durationMs: observation.durationMs,
    stdout: observation.stdoutDelta,
    stderr: observation.stderrDelta,
    truncated: observation.truncated,
    matchedPattern: observation.matchedPattern,
  });
}

function rolePrompt(prompt: string, allowedTools: readonly string[], finalFields: string): string {
  return `${prompt.trim()}\n\nProtocol: return exactly one JSON object per turn. A tool turn is {"kind":"tool_call","callId":"unique-id","tool":"one_allowed_tool","input":{...}}. A completion is {"kind":"complete",${finalFields}}. Allowed tools: ${allowedTools.join(", ")}. Never include prose outside the JSON object.`;
}

async function runDiagnosis(
  context: RoleContext,
  pass: number,
  observation: ProcessObservation,
  reviewFeedback: readonly string[],
): Promise<DiagnosisRecord> {
  const definition: AgentDefinition<DiagnosisFinal> = {
    id: "diagnostician",
    systemPrompt: rolePrompt(
      context.prompts.diagnostician,
      context.permissions.diagnostician,
      '"summary":"...","evidence":["..."],"findings":["..."],"likelyFiles":["relative/path"]',
    ),
    allowedTools: context.permissions.diagnostician,
    finalSchema: DiagnosisFinalSchema,
  };
  const result = await context.runner.run(definition, {
    runId: context.runId,
    task: `Diagnose build pass ${pass}. Bounded process evidence: ${processTask(observation)}. Prior review feedback: ${JSON.stringify(reviewFeedback)}.`,
    model: context.model,
    temperature: 0.1,
    contextTokens: 32_768,
    maxOutputTokens: 512,
    maximumSteps: 16,
    dryRun: context.dryRun,
    modelClient: context.runtimeModelClient,
    tools: context.registry,
    retryPolicy: new RetryPolicy(2, 250),
    shouldRetryModelError: modelRetryable,
    trace: context.trace,
  });
  return {
    summary: result.final.summary,
    evidence: result.final.evidence,
    findings: result.final.findings,
    likelyFiles: result.final.likelyFiles,
  };
}

async function runRepair(
  context: RoleContext,
  pass: number,
  diagnosis: DiagnosisRecord,
): Promise<RepairRecord> {
  const definition: AgentDefinition<RepairFinal> = {
    id: "repairer",
    systemPrompt: rolePrompt(
      context.prompts.repairer,
      context.permissions.repairer,
      '"summary":"...","evidence":["..."],"findings":["..."],"changedFiles":["relative/path"]',
    ),
    allowedTools: context.permissions.repairer,
    finalSchema: RepairFinalSchema,
  };
  const result = await context.runner.run(definition, {
    runId: context.runId,
    task: `Repair pass ${pass}. Diagnosis: ${JSON.stringify(diagnosis)}. Make only evidence-backed changes. Read a file before updating it and supply the observed SHA-256.`,
    model: context.model,
    temperature: 0.1,
    contextTokens: 32_768,
    maxOutputTokens: 512,
    maximumSteps: 20,
    dryRun: context.dryRun,
    modelClient: context.runtimeModelClient,
    tools: context.registry,
    retryPolicy: new RetryPolicy(2, 250),
    shouldRetryModelError: modelRetryable,
    trace: context.trace,
  });
  return {
    summary: result.final.summary,
    evidence: result.final.evidence,
    findings: result.final.findings,
    changedFiles: result.final.changedFiles,
  };
}

async function runReview(
  context: RoleContext,
  pass: number,
  diagnosis: DiagnosisRecord,
  repair: RepairRecord,
  verification: ProcessObservation | undefined,
): Promise<ReviewRecord> {
  const definition: AgentDefinition<ReviewFinal> = {
    id: "reviewer",
    systemPrompt: rolePrompt(
      context.prompts.reviewer,
      context.permissions.reviewer,
      '"summary":"...","evidence":["..."],"findings":["..."],"approved":true',
    ),
    allowedTools: context.permissions.reviewer,
    finalSchema: ReviewFinalSchema,
  };
  const result = await context.runner.run(definition, {
    runId: context.runId,
    task: `Review pass ${pass}. Diagnosis: ${JSON.stringify(diagnosis)}. Repair: ${JSON.stringify(repair)}. Verification: ${verification === undefined ? "not executed because this is a dry run" : processTask(verification)}. Inspect the overlay or workspace as appropriate.`,
    model: context.model,
    temperature: 0.1,
    contextTokens: 32_768,
    maxOutputTokens: 512,
    maximumSteps: 16,
    dryRun: context.dryRun,
    modelClient: context.runtimeModelClient,
    tools: context.registry,
    retryPolicy: new RetryPolicy(2, 250),
    shouldRetryModelError: modelRetryable,
    trace: context.trace,
  });
  return {
    summary: result.final.summary,
    evidence: result.final.evidence,
    findings: result.final.findings,
    approved: result.final.approved,
  };
}

async function executeOneShot(
  runtime: ProcessRuntime,
  commandId: string,
  signal: AbortSignal | undefined,
): Promise<ProcessObservation> {
  const result = await runtime.manager.runOneShot(
    { commandId },
    signal === undefined ? {} : { signal },
  );
  runtime.context.useOneShot(result);
  return observeOneShot(result);
}

async function observeRunningWatcher(
  runtime: ProcessRuntime,
  signal: AbortSignal | undefined,
): Promise<ProcessObservation> {
  if (runtime.watcher === undefined || runtime.watcherPolicy === undefined) {
    throw new BuildAssistantError(
      "WATCHER_STATE_INVALID",
      "Watcher observation was requested without a watcher policy.",
      "infrastructure",
    );
  }
  const observed = await observeWatcher(runtime.watcher, runtime.watcherPolicy, {
    timeoutMs: runtime.timeoutMs,
    offsets: runtime.offsets,
    ...(signal === undefined ? {} : { signal }),
  });
  runtime.offsets = observed.offsets;
  return observed.observation;
}

async function recordProcess(
  trace: TraceRecorder,
  runId: string,
  phase: string,
  observation: ProcessObservation,
): Promise<void> {
  await trace.record({
    type: "process",
    status: observation.status,
    runId,
    metadata: { phase, ...logMetadata(observation) },
  });
}

function safeObservation(observation: ProcessObservation): Readonly<Record<string, unknown>> {
  return logMetadata(observation);
}

function workspaceIdentity(workspaceRoot: string): string {
  const identity = process.platform === "win32" ? workspaceRoot.toLowerCase() : workspaceRoot;
  return createHash("sha256").update(identity).digest("hex");
}

function scrubAbsolutePaths(value: string, knownPaths: readonly string[]): string {
  let scrubbed = value;
  for (const knownPath of [...knownPaths].sort((left, right) => right.length - left.length)) {
    if (knownPath.length > 0) scrubbed = scrubbed.replaceAll(knownPath, "[ABSOLUTE_PATH]");
  }
  return scrubbed
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\r\n"'<>|]+/gu, "[ABSOLUTE_PATH]")
    .replace(/(^|\s)\/(?:[^\s"'<>|]+\/?)+/gu, "$1[ABSOLUTE_PATH]");
}

function safePersistentValue(value: unknown, knownPaths: readonly string[]): unknown {
  if (typeof value === "string") return scrubAbsolutePaths(value, knownPaths);
  if (Array.isArray(value)) {
    return value.map((item) => safePersistentValue(item, knownPaths));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, safePersistentValue(item, knownPaths)]),
    );
  }
  return value;
}

function safePass(pass: BuildPassRecord): Readonly<Record<string, unknown>> {
  return {
    pass: pass.pass,
    diagnosis: pass.diagnosis,
    repair: pass.repair,
    ...(pass.verification === undefined
      ? {}
      : { verification: safeObservation(pass.verification) }),
    ...(pass.review === undefined ? {} : { review: pass.review }),
  };
}

function reportMarkdown(result: BuildAssistantResult, knownPaths: readonly string[]): string {
  const lines = [
    "# Build Assistant Final Report",
    "",
    `- Status: ${result.status}`,
    `- Final status: ${result.finalStatus}`,
    `- Mode: ${result.mode}`,
    `- Command: ${result.commandId}`,
    `- Watcher: ${String(result.watcher)}`,
    `- Repair passes: ${result.passes.length}`,
    `- Changed files: ${result.changedFiles.length}`,
    "",
    result.summary,
  ];
  for (const pass of result.passes) {
    lines.push(
      "",
      `## Pass ${pass.pass}`,
      "",
      `Diagnosis: ${pass.diagnosis.summary}`,
      "",
      `Repair: ${pass.repair.summary}`,
      "",
      `Review: ${pass.review?.summary ?? "not executed"}`,
    );
  }
  if (result.mode === "dry-run" && result.changedFiles.length > 0) {
    lines.push(
      "",
      "> Repair proposed, verification not executed. The target workspace was not changed.",
    );
  }
  return `${scrubAbsolutePaths(lines.join("\n"), knownPaths)}\n`;
}

async function writeReports(
  writer: ReportWriter,
  directory: RunDirectory,
  result: BuildAssistantResult,
): Promise<void> {
  const knownPaths = [result.workspace, result.runDirectory];
  const observations = [
    { phase: "initial", observation: result.initial },
    ...result.passes.flatMap((pass) =>
      pass.verification === undefined
        ? []
        : [{ phase: `verification-${pass.pass}`, observation: pass.verification }],
    ),
  ];
  await Promise.all([
    writer.writeText(directory.finalReportPath, reportMarkdown(result, knownPaths)),
    writer.writeJson(
      directory.finalResultPath,
      safePersistentValue(
        {
          status: result.status,
          finalStatus: result.finalStatus,
          summary: result.summary,
          mode: result.mode,
          commandId: result.commandId,
          runId: result.runId,
          runDirectory: path.basename(result.runDirectory),
          workspace: {
            name: path.basename(result.workspace),
            identitySha256: workspaceIdentity(result.workspace),
          },
          watcher: result.watcher,
          initial: safeObservation(result.initial),
          passes: result.passes.map(safePass),
          changedFiles: result.changedFiles,
        },
        knownPaths,
      ),
    ),
    writer.writeJson(
      path.join(directory.path, "build-attempts.json"),
      safePersistentValue({ passes: result.passes.map(safePass) }, knownPaths),
    ),
    writer.writeJson(path.join(directory.path, "mutation-journal.json"), {
      mutations: result.changedFiles,
    }),
    writer.writeJson(path.join(directory.path, "process-log-metadata.json"), {
      observations: observations.map(({ phase, observation }) => ({
        phase,
        ...safeObservation(observation),
      })),
    }),
    writer.writeJson(
      path.join(directory.path, "process-logs.json"),
      safePersistentValue(
        {
          observations: observations.map(({ phase, observation }) => ({
            phase,
            stdout: observation.stdoutDelta,
            stderr: observation.stderrDelta,
            truncated: observation.truncated,
          })),
        },
        knownPaths,
      ),
    ),
  ]);
}

async function writeFailureReports(
  writer: ReportWriter,
  directory: RunDirectory,
  error: unknown,
  knownPaths: readonly string[],
): Promise<void> {
  const safe = sanitizedError(error);
  const message = scrubAbsolutePaths(safe.message, knownPaths);
  await Promise.all([
    writer.writeText(
      directory.finalReportPath,
      `# Build Assistant Final Report\n\nStatus: failed\n\n${message}\n`,
    ),
    writer.writeJson(directory.finalResultPath, {
      status: "failed",
      error: { ...safe, message },
    }),
  ]);
}

export async function runBuildAssistant(
  options: BuildAssistantWorkflowOptions,
  dependencies: BuildAssistantWorkflowDependencies = {},
): Promise<BuildAssistantResult> {
  const locations = dependencies.locations ?? (await resolveApplicationLocations());
  const requestedModel = options.requestedModel ?? DEFAULT_MODEL;
  const initialGuard = await WorkspaceGuard.create(path.resolve(options.workspace));
  const workspaceRoot = initialGuard.root;
  const reportsRoot = path.resolve(
    options.reportsRoot ?? path.join(locations.laboratoryRoot, "reports", "runs"),
  );
  assertReportsOutsideWorkspace(workspaceRoot, reportsRoot);

  const commandPolicy = await loadCommandPolicy({
    applicationRoot: locations.applicationRoot,
    workspaceRoot,
    ...(options.commandConfigurationPath === undefined
      ? {}
      : { selectedPath: options.commandConfigurationPath }),
  });
  const command = commandPolicy.allowlist.resolve({ commandId: options.commandId });
  const protectedWorkspacePaths = [
    commandPolicy.canonicalConfigurationPath,
    path.join(locations.applicationRoot, "config"),
    path.join(locations.applicationRoot, "prompts"),
  ]
    .map((candidate) => relativeProtectedPath(workspaceRoot, candidate))
    .filter((candidate): candidate is string => candidate !== undefined)
    .flatMap((candidate) => [candidate, `${candidate}/**`]);
  const guard = await WorkspaceGuard.create(workspaceRoot, {
    forbiddenGlobs: protectedWorkspacePaths,
  });

  const reportWriter = new ReportWriter();
  const directory = await new RunDirectoryManager(reportsRoot, reportWriter).create({
    application: "build-assistant",
    workspaceRoot,
    modelProvider: options.mock === true ? "mock" : "lmstudio",
    requestedModel,
    mode: options.mode,
  });
  // Add application-specific metadata before tracing or workflow work begins.
  await reportWriter.writeJson(directory.metadataPath, {
    runId: directory.runId,
    application: "build-assistant",
    startedAt: new Date().toISOString(),
    workspace: {
      name: path.basename(workspaceRoot),
      identitySha256: workspaceIdentity(workspaceRoot),
    },
    modelProvider: options.mock === true ? "mock" : "lmstudio",
    requestedModel,
    mode: options.mode,
    processId: process.pid,
    nodeVersion: process.version,
  });
  const trace = new TraceRecorder(new JsonlTraceWriter(directory.tracePath));
  let lock: WorkspaceLockHandle | undefined;
  let processRuntime: ProcessRuntime | undefined;
  let completed = false;

  try {
    await trace.record({
      type: "workflow",
      status: "initialized",
      runId: directory.runId,
      metadata: {
        mode: options.mode,
        commandId: options.commandId,
        watcher: commandPolicy.watcherByCommand.has(options.commandId),
      },
    });
    lock = await WorkspaceLock.acquire({
      workspaceRoot,
      trustedLockRoot: path.join(reportsRoot, "locks"),
    });
    const processManager =
      dependencies.processManagerFactory?.(commandPolicy.allowlist) ??
      new ProcessManager(commandPolicy.allowlist);
    const processContext = new ProcessContext();
    const watcherPolicy = commandPolicy.watcherByCommand.get(options.commandId);
    let watcher: WatcherHandle | undefined;
    if (watcherPolicy !== undefined) {
      watcher = processManager.startWatcher({ commandId: options.commandId });
      processContext.useWatcher(watcher);
    }
    processRuntime = {
      manager: processManager,
      context: processContext,
      ...(watcher === undefined ? {} : { watcher }),
      ...(watcherPolicy === undefined ? {} : { watcherPolicy }),
      timeoutMs: command.timeoutMs,
      offsets: { stdoutBytes: 0, stderrBytes: 0 },
    };

    const initial =
      watcher === undefined
        ? await executeOneShot(processRuntime, options.commandId, options.signal)
        : await observeRunningWatcher(processRuntime, options.signal);
    await recordProcess(trace, directory.runId, "initial", initial);

    if (initial.status === "succeeded") {
      const result: BuildAssistantResult = {
        status: "succeeded",
        finalStatus: "initial-command-succeeded",
        summary: "The trusted command succeeded without repair.",
        mode: options.mode,
        commandId: options.commandId,
        runId: directory.runId,
        runDirectory: directory.path,
        workspace: workspaceRoot,
        watcher: watcher !== undefined,
        initial,
        passes: [],
        changedFiles: [],
      };
      await writeReports(reportWriter, directory, result);
      completed = true;
      return result;
    }

    const permissions = await loadRolePermissions(locations.applicationRoot);
    const prompts = {
      diagnostician: await loadSystemPrompt(locations.applicationRoot, "diagnostician"),
      repairer: await loadSystemPrompt(locations.applicationRoot, "repairer"),
      reviewer: await loadSystemPrompt(locations.applicationRoot, "reviewer"),
    } as const;

    let runtimeModelClient: RuntimeModelClient;
    if (dependencies.runtimeModelClient !== undefined) {
      runtimeModelClient = dependencies.runtimeModelClient;
      await reportWriter.writeJson(directory.diagnosticsPath, { provider: "injected" });
    } else if (options.mock === true) {
      runtimeModelClient = new BuildAssistantMockModelClient();
      await reportWriter.writeJson(directory.diagnosticsPath, {
        provider: "mock",
        status: "healthy",
      });
    } else {
      const client = createLocalModelClient({ provider: "lmstudio" });
      const health = await client.healthCheck();
      await reportWriter.writeJson(directory.diagnosticsPath, health);
      if (!health.ok) {
        throw new BuildAssistantError(
          "MODEL_UNAVAILABLE",
          health.error?.message ?? "LM Studio is unavailable.",
          "model",
        );
      }
      runtimeModelClient = new LocalRuntimeModelAdapter(client, options.signal);
    }

    let currentPass = 0;
    const toolset = createBuildToolRegistry({
      guard,
      dryRun: options.mode === "dry-run",
      processContext,
      trace,
      runId: directory.runId,
      currentPass: () => currentPass,
    });
    const roleContext: RoleContext = {
      runner: new AgentRunner(),
      runtimeModelClient,
      permissions,
      prompts,
      model: options.mock === true ? "mock/coder" : requestedModel,
      runId: directory.runId,
      dryRun: options.mode === "dry-run",
      registry: toolset.registry,
      trace,
    };
    const passes: BuildPassRecord[] = [];
    let observation = initial;
    let reviewFeedback: readonly string[] = [];

    for (let pass = 1; pass <= MAX_REPAIR_PASSES; pass += 1) {
      currentPass = pass;
      const beforeChanges = toolset.changes.length;
      const diagnosis = await runDiagnosis(roleContext, pass, observation, reviewFeedback);
      const repair = await runRepair(roleContext, pass, diagnosis);
      const madeChange = toolset.changes.length > beforeChanges;

      if (options.mode === "dry-run") {
        const review = await runReview(roleContext, pass, diagnosis, repair, undefined);
        passes.push({ pass, diagnosis, repair, review });
        reviewFeedback = review.findings;
        if (madeChange && review.approved) break;
        continue;
      }

      const verification =
        watcher === undefined
          ? await executeOneShot(processRuntime, options.commandId, options.signal)
          : await observeRunningWatcher(processRuntime, options.signal);
      observation = verification;
      await recordProcess(trace, directory.runId, `verification-${pass}`, verification);
      const review = await runReview(roleContext, pass, diagnosis, repair, verification);
      passes.push({ pass, diagnosis, repair, verification, review });
      reviewFeedback = review.findings;
      if (verification.status === "succeeded" && review.approved) {
        const result: BuildAssistantResult = {
          status: "succeeded",
          finalStatus: "verified",
          summary: `The trusted command succeeded after ${pass} repair pass${pass === 1 ? "" : "es"}.`,
          mode: options.mode,
          commandId: options.commandId,
          runId: directory.runId,
          runDirectory: directory.path,
          workspace: workspaceRoot,
          watcher: watcher !== undefined,
          initial,
          passes,
          changedFiles: [...toolset.changes],
        };
        await writeReports(reportWriter, directory, result);
        completed = true;
        return result;
      }
    }

    const changedFiles: readonly FileChangeRecord[] = [...toolset.changes];
    const proposed = options.mode === "dry-run" && changedFiles.length > 0;
    const result: BuildAssistantResult = {
      status: "failed",
      finalStatus: proposed ? "repair-proposed-verification-not-executed" : "unresolved",
      summary: proposed
        ? "Repair proposed, verification not executed; the target workspace remains unchanged."
        : `The trusted command remains unresolved after ${MAX_REPAIR_PASSES} bounded repair passes.`,
      mode: options.mode,
      commandId: options.commandId,
      runId: directory.runId,
      runDirectory: directory.path,
      workspace: workspaceRoot,
      watcher: watcher !== undefined,
      initial,
      passes,
      changedFiles,
    };
    await writeReports(reportWriter, directory, result);
    completed = true;
    return result;
  } catch (error) {
    if (!completed)
      await writeFailureReports(reportWriter, directory, error, [
        workspaceRoot,
        directory.path,
        commandPolicy.canonicalConfigurationPath,
      ]).catch(() => undefined);
    throw asBuildAssistantError(error);
  } finally {
    await processRuntime?.manager.dispose().catch(() => undefined);
    if (lock !== undefined) await lock.release().catch(() => undefined);
    await trace
      .record({
        type: "workflow",
        status: completed ? "completed" : "failed",
        runId: directory.runId,
      })
      .catch(() => undefined);
    await trace.close().catch(() => undefined);
  }
}
