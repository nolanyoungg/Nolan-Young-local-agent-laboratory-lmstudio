import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import {
  AgentRunner,
  AgentRuntimeError,
  RetryPolicy,
  type AgentDefinition,
} from "@local-agent-lab/agent-runtime";
import {
  ModelClientError,
  ModelClientErrorCode,
  type LocalModelClient,
} from "@local-agent-lab/local-model-client";
import {
  JsonlTraceWriter,
  ReportWriter,
  RunDirectoryManager,
  TraceRecorder,
} from "@local-agent-lab/tracing";
import { WorkspaceGuard, WorkspaceLock, isPathInside } from "@local-agent-lab/workspace-security";

import { CodeEditorUsageError, type CodeEditorConfig } from "./Configuration.js";
import { RuntimeLocalModelAdapter, createCodeEditorModelClient } from "./ModelAdapter.js";
import { CodeEditorReportWriter, type CodeEditorOutcome } from "./Reports.js";
import { createCodeEditorTools, type CodeEditorTools } from "./Tooling.js";
import {
  EditorFinalSchema,
  PlannerFinalSchema,
  ReviewerFinalSchema,
  type EditorFinal,
  type PlannerFinal,
  type ReviewerFinal,
} from "./types.js";

const MAXIMUM_REVIEW_PASSES = 3;

export interface CodeEditorWorkflowDependencies {
  readonly modelClient?: LocalModelClient;
  readonly signal?: AbortSignal;
  readonly runDirectoryManager?: RunDirectoryManager;
  readonly reportWriter?: ReportWriter;
}

export async function runCodeEditor(
  config: CodeEditorConfig,
  dependencies: CodeEditorWorkflowDependencies = {},
): Promise<CodeEditorOutcome> {
  throwIfAborted(dependencies.signal);
  const guard = await WorkspaceGuard.create(config.workspace, {
    readGlobs: config.editPolicy.readAllow,
    writeGlobs: config.editPolicy.writeAllow,
    forbiddenGlobs: config.editPolicy.deny,
  });
  const canonicalReportsDestination = await canonicalPlannedDestination(config.reportsRoot);
  if (isPathInside(guard.root, canonicalReportsDestination)) {
    throw new CodeEditorUsageError(
      "The trusted reports and lock root must be outside the target workspace",
    );
  }

  const writer = dependencies.reportWriter ?? new ReportWriter();
  const manager = dependencies.runDirectoryManager ?? new RunDirectoryManager(config.reportsRoot);
  const run = await manager.create({
    application: "code-editor",
    workspaceRoot: guard.root,
    modelProvider: config.mock ? "mock" : "lmstudio",
    requestedModel: config.requestedModel,
    mode: config.mode,
  });
  const trace = new TraceRecorder(new JsonlTraceWriter(run.tracePath));
  const reports = new CodeEditorReportWriter(writer);
  let lock: WorkspaceLock | undefined;
  let tools: CodeEditorTools | undefined;

  try {
    await trace.record({
      type: "workflow",
      status: "started",
      runId: run.runId,
      metadata: { application: "code-editor", mode: config.mode },
    });
    lock = await WorkspaceLock.acquire({
      workspaceRoot: guard.root,
      trustedLockRoot: config.lockRoot,
    });
    await trace.record({
      type: "workspace_lock",
      status: "acquired",
      runId: run.runId,
      metadata: { lockNonce: lock.nonce },
    });

    const modelClient = dependencies.modelClient ?? createCodeEditorModelClient(config);
    const resolvedModel = await diagnoseAndResolveModel(
      config,
      modelClient,
      writer,
      trace,
      run,
      dependencies.signal,
    );
    throwIfAborted(dependencies.signal);

    tools = createCodeEditorTools({
      guard,
      policy: config.editPolicy,
      dryRun: config.mode !== "apply",
      trace,
      runId: run.runId,
    });
    const outcome = await executeRoles({
      config,
      runDirectory: run,
      modelClient: new RuntimeLocalModelAdapter(modelClient, dependencies.signal),
      model: resolvedModel,
      tools,
      trace,
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    });

    await reports.writeOutcome(config, outcome, tools.journal, tools.registry.mutationJournal());
    await trace.record({
      type: "workflow",
      status: outcome.success ? "completed" : "failed",
      runId: run.runId,
      metadata: {
        changedFiles: outcome.changedFiles.length,
        reviewPasses: outcome.reviews.length,
        result: outcome.status,
      },
    });
    await lock.release();
    lock = undefined;
    await trace.record({
      type: "workspace_lock",
      status: "released",
      runId: run.runId,
    });
    return outcome;
  } catch (error) {
    if (lock !== undefined) {
      try {
        await lock.release();
        await trace.record({
          type: "workspace_lock",
          status: "released",
          runId: run.runId,
        });
      } catch (releaseError) {
        await trace.recordError({ type: "workspace_lock", runId: run.runId }, releaseError);
      }
    }
    await trace.recordError({ type: "workflow", runId: run.runId }, error);
    await reports.writeFailure(
      config,
      run,
      error,
      tools?.journal,
      tools?.registry.mutationJournal() ?? [],
    );
    throw error;
  } finally {
    await trace.close();
  }
}

interface RoleExecutionOptions {
  readonly config: CodeEditorConfig;
  readonly runDirectory: Awaited<ReturnType<RunDirectoryManager["create"]>>;
  readonly modelClient: RuntimeLocalModelAdapter;
  readonly model: string;
  readonly tools: CodeEditorTools;
  readonly trace: TraceRecorder;
  readonly signal?: AbortSignal;
}

async function executeRoles(options: RoleExecutionOptions): Promise<CodeEditorOutcome> {
  const runner = new AgentRunner();
  const planner = await runPlanner(runner, options);
  if (options.config.mode === "plan-only") {
    return {
      runDirectory: options.runDirectory,
      mode: options.config.mode,
      status: "plan-complete",
      success: true,
      planner,
      editorRuns: [],
      reviews: [],
      changedFiles: [],
      proposedDiff: "",
      editingSkipped: true,
      reviewSkipped: true,
    };
  }

  const editorRuns: EditorFinal[] = [];
  const reviews: ReviewerFinal[] = [];
  editorRuns.push(await runEditor(runner, options, planner));

  for (let pass = 1; pass <= MAXIMUM_REVIEW_PASSES; pass += 1) {
    throwIfAborted(options.signal);
    const review = await runReviewer(runner, options, planner, pass);
    reviews.push(review);
    if (review.approved) {
      break;
    }
    if (pass < MAXIMUM_REVIEW_PASSES) {
      editorRuns.push(await runEditor(runner, options, planner, review.requiredChanges, pass));
    }
  }

  const approved = reviews.at(-1)?.approved === true;
  const changedFiles = options.tools.journal.changedFiles();
  return {
    runDirectory: options.runDirectory,
    mode: options.config.mode,
    status: approved
      ? options.config.mode === "dry-run"
        ? "repair-proposed"
        : "changes-applied"
      : "review-failed",
    success: approved,
    planner,
    editorRuns,
    reviews,
    changedFiles,
    proposedDiff: options.tools.journal.unifiedDiff(),
    editingSkipped: false,
    reviewSkipped: false,
  };
}

async function runPlanner(
  runner: AgentRunner,
  options: RoleExecutionOptions,
): Promise<PlannerFinal> {
  throwIfAborted(options.signal);
  const definition: AgentDefinition<PlannerFinal> = {
    id: "planner",
    systemPrompt: options.config.prompts.planner,
    allowedTools: options.config.permissions.planner,
    finalSchema: PlannerFinalSchema,
  };
  const result = await runner.run(definition, {
    ...commonAgentOptions(options, 16),
    task: `Inspect the confined workspace and produce a change plan for this task:\n\n${options.config.task}`,
  });
  return stripCompletionKind(result.final, PlannerFinalSchema);
}

async function runEditor(
  runner: AgentRunner,
  options: RoleExecutionOptions,
  planner: PlannerFinal,
  requiredChanges: readonly string[] = [],
  repairPass = 0,
): Promise<EditorFinal> {
  throwIfAborted(options.signal);
  const definition: AgentDefinition<EditorFinal> = {
    id: repairPass === 0 ? "editor" : `editor-repair-${repairPass}`,
    systemPrompt: options.config.prompts.editor,
    allowedTools: options.config.permissions.editor,
    finalSchema: EditorFinalSchema,
  };
  const repairInstruction =
    requiredChanges.length === 0
      ? ""
      : `\n\nThe read-only reviewer requires these focused repairs:\n${requiredChanges
          .map((change) => `- ${change}`)
          .join("\n")}`;
  const result = await runner.run(definition, {
    ...commonAgentOptions(options, 32),
    task: `Implement the task using only the controlled tools.

Task:
${options.config.task}

Approved plan envelope:
${JSON.stringify(planner)}${repairInstruction}`,
  });
  return stripCompletionKind(result.final, EditorFinalSchema);
}

async function runReviewer(
  runner: AgentRunner,
  options: RoleExecutionOptions,
  planner: PlannerFinal,
  pass: number,
): Promise<ReviewerFinal> {
  throwIfAborted(options.signal);
  const definition: AgentDefinition<ReviewerFinal> = {
    id: `reviewer-${pass}`,
    systemPrompt: options.config.prompts.reviewer,
    allowedTools: options.config.permissions.reviewer,
    finalSchema: ReviewerFinalSchema,
  };
  const changedFiles = options.tools.journal.changedFiles();
  const result = await runner.run(definition, {
    ...commonAgentOptions(options, 20),
    task: `Review the current ${options.config.mode === "dry-run" ? "virtual overlay" : "workspace"} against the task and plan.

Task:
${options.config.task}

Plan:
${JSON.stringify(planner)}

Observed mutation metadata:
${JSON.stringify(changedFiles)}`,
  });
  const review = stripCompletionKind(result.final, ReviewerFinalSchema);
  if (
    (review.approved && review.findings.some((finding) => finding.severity === "error")) ||
    (!review.approved && review.requiredChanges.length === 0)
  ) {
    throw new AgentRuntimeError(
      "INVALID_MODEL_RESPONSE",
      "Reviewer completion envelope is internally inconsistent",
    );
  }
  return review;
}

function commonAgentOptions(options: RoleExecutionOptions, maximumSteps: number) {
  return {
    runId: options.runDirectory.runId,
    model: options.model,
    temperature: options.config.temperature,
    contextTokens: options.config.contextTokens,
    maxOutputTokens: options.config.maxOutputTokens,
    maximumSteps,
    dryRun: options.config.mode !== "apply",
    modelClient: options.modelClient,
    tools: options.tools.registry,
    retryPolicy: new RetryPolicy(0, 0),
    trace: options.trace,
    shouldRetryModelError: () => false,
  } as const;
}

async function diagnoseAndResolveModel(
  config: CodeEditorConfig,
  client: LocalModelClient,
  writer: ReportWriter,
  trace: TraceRecorder,
  run: Awaited<ReturnType<RunDirectoryManager["create"]>>,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const health = await trace.measure({ type: "model_health", runId: run.runId }, async () =>
    client.healthCheck(),
  );
  if (!health.ok) {
    throw new ModelClientError(
      ModelClientErrorCode.endpointUnavailable,
      health.error?.message ?? "LM Studio health check failed",
      health.error?.retryable === undefined ? {} : { retryable: health.error.retryable },
    );
  }
  const resolved = await trace.measure({ type: "model_resolution", runId: run.runId }, async () =>
    client.resolveModel(config.requestedModel, signal),
  );
  await writer.writeJson(run.diagnosticsPath, {
    provider: config.mock ? "mock" : "lmstudio",
    health,
    requestedModel: config.requestedModel,
    resolved: {
      logicalKey: resolved.logicalKey,
      selectedVariantId: resolved.selectedVariantId,
      displayName: resolved.displayName,
      matchType: resolved.matchType,
      variants: resolved.variants.map((variant) => ({
        variantId: variant.variantId,
        format: variant.format,
        loaded: variant.loaded,
        contextLength: variant.contextLength,
        capabilities: variant.capabilities,
        source: variant.source,
        device: variant.device,
      })),
      routingMetadataAvailable: resolved.routingMetadataAvailable,
    },
    routingNotice:
      "Preferred linked-device execution requires confirmation in LM Studio; a response alone is not proof of routing.",
  });
  return resolved.selectedVariantId;
}

function stripCompletionKind<T extends Readonly<Record<string, unknown>>>(
  completion: Readonly<{ kind: "complete" }> & T,
  schema: { parse(value: unknown): T },
): T {
  const value = Object.fromEntries(Object.entries(completion).filter(([key]) => key !== "kind"));
  return schema.parse(value);
}

async function canonicalPlannedDestination(candidate: string): Promise<string> {
  let existing = path.resolve(candidate);
  const missingSegments: string[] = [];
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
      const parent = path.dirname(existing);
      if (parent === existing) {
        throw error;
      }
      missingSegments.unshift(path.basename(existing));
      existing = parent;
    }
  }
  return path.resolve(await realpath(existing), ...missingSegments);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("Code editor workflow was interrupted", "AbortError");
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
