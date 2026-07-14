import { createHash } from "node:crypto";
import { posix } from "node:path";

import {
  ToolRegistry,
  type RuntimeTrace,
  type ToolExecutionContext,
} from "@local-agent-lab/agent-runtime";
import {
  ToolFactory,
  type FileMutationResult,
  type FilesystemToolSet,
} from "@local-agent-lab/filesystem-tools";
import type {
  ProcessLogSnapshot,
  ProcessResult,
  ProcessStatusSnapshot,
  WatcherHandle,
} from "@local-agent-lab/process-tools";
import type { WorkspaceGuard } from "@local-agent-lab/workspace-security";
import { z } from "zod";

import { boundedLogDelta, type LogOffsets } from "./process-observer.js";
import type { FileChangeRecord } from "./types.js";

const RelativePathSchema = z.string().min(1).max(1_024);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const ListFilesInputSchema = z
  .object({
    path: RelativePathSchema.default("."),
    recursive: z.boolean().default(false),
    maxResults: z.number().int().positive().max(2_000).default(500),
  })
  .strict();
const ReadFileInputSchema = z
  .object({
    path: RelativePathSchema,
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .max(128 * 1_024)
      .optional(),
  })
  .strict();
const MetadataInputSchema = z.object({ path: RelativePathSchema }).strict();
const SearchInputSchema = z
  .object({
    path: RelativePathSchema.default("."),
    query: z.string().min(1).max(1_000),
    caseSensitive: z.boolean().default(false),
    maxResults: z.number().int().positive().max(200).default(100),
  })
  .strict();
const CreateInputSchema = z
  .object({ path: RelativePathSchema, content: z.string().max(1_048_576) })
  .strict();
const WriteInputSchema = z
  .object({
    path: RelativePathSchema,
    content: z.string().max(1_048_576),
    expectedSha256: Sha256Schema,
  })
  .strict();
const PatchInputSchema = z
  .object({
    path: RelativePathSchema,
    patch: z.string().min(1).max(1_048_576),
    expectedSha256: Sha256Schema,
  })
  .strict();
const EmptyInputSchema = z.object({}).strict();

export class ProcessContext {
  #logs: (() => ProcessLogSnapshot) | undefined;
  #status: (() => unknown) | undefined;
  #offsets: LogOffsets = { stdoutBytes: 0, stderrBytes: 0 };

  public useOneShot(result: ProcessResult): void {
    this.#logs = () => result;
    this.#status = () => ({
      commandId: result.commandId,
      pid: result.pid,
      status: result.exitCode === 0 && !result.timedOut ? "exited" : "failed",
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
    });
    this.#offsets = { stdoutBytes: 0, stderrBytes: 0 };
  }

  public useWatcher(handle: WatcherHandle): void {
    this.#logs = () => handle.getLogs();
    this.#status = () =>
      handle.getStatus() ?? {
        commandId: handle.commandId,
        pid: handle.pid,
        status: "running",
      };
    this.#offsets = { stdoutBytes: 0, stderrBytes: 0 };
  }

  public readStatus(): unknown {
    return this.#status?.() ?? { status: "not-started" };
  }

  public readLogDelta(): Readonly<Record<string, unknown>> {
    if (this.#logs === undefined) {
      return { stdout: "", stderr: "", truncated: false, status: "not-started" };
    }
    const snapshot = this.#logs();
    const delta = boundedLogDelta(snapshot, this.#offsets);
    this.#offsets = delta.offsets;
    return {
      stdout: delta.stdout,
      stderr: delta.stderr,
      stdoutBytes: snapshot.stdoutBytes,
      stderrBytes: snapshot.stderrBytes,
      truncated: snapshot.truncated,
    };
  }
}

export interface BuildToolRegistry {
  readonly registry: ToolRegistry;
  readonly filesystem: FilesystemToolSet;
  readonly changes: readonly FileChangeRecord[];
}

function normalizeFingerprintValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeFingerprintValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([nestedKey, item]) => [nestedKey, normalizeFingerprintValue(item, nestedKey)]),
    );
  }
  if (typeof value === "string" && /(?:^|_)path$/iu.test(key ?? "")) {
    const portable = posix.normalize(value.replaceAll("\\", "/"));
    return process.platform === "win32" ? portable.toLowerCase() : portable;
  }
  return value;
}

function mutationFingerprint(tool: string, input: unknown, dryRun: boolean): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeFingerprintValue({ tool, input, dryRun, mutation: true })))
    .digest("hex");
}

export function createBuildToolRegistry(
  options: Readonly<{
    guard: WorkspaceGuard;
    dryRun: boolean;
    processContext: ProcessContext;
    trace: RuntimeTrace;
    runId: string;
    currentPass: () => number;
  }>,
): BuildToolRegistry {
  const filesystem = ToolFactory.create(options.guard, { dryRun: options.dryRun });
  const registry = new ToolRegistry();
  const changes: FileChangeRecord[] = [];

  registry.register({
    name: "list_files",
    description: "List authorized workspace entries with bounded output.",
    mutating: false,
    inputSchema: ListFilesInputSchema,
    execute: async (input) => await filesystem.listFiles.execute(input),
  });
  registry.register({
    name: "read_file",
    description: "Read an authorized UTF-8 file or line range and return its SHA-256.",
    mutating: false,
    inputSchema: ReadFileInputSchema,
    execute: async (input) => await filesystem.readFile.execute(input),
  });
  registry.register({
    name: "read_file_metadata",
    description: "Read bounded metadata and SHA-256 for an authorized path.",
    mutating: false,
    inputSchema: MetadataInputSchema,
    execute: async (input) => await filesystem.readFileMetadata.execute(input),
  });
  registry.register({
    name: "search_text",
    description: "Search authorized UTF-8 files and return bounded line matches.",
    mutating: false,
    inputSchema: SearchInputSchema,
    execute: async (input) => await filesystem.searchText.execute(input),
  });

  const recordMutation = async (
    tool: "apply_patch" | "create_file" | "write_file",
    operation: "create" | "update",
    inputPath: string,
    input: unknown,
    context: ToolExecutionContext,
    execute: () => Promise<FileMutationResult>,
  ): Promise<FileMutationResult> => {
    const fingerprint = mutationFingerprint(tool, input, context.dryRun);
    await options.trace.record({
      type: "mutation_authorization",
      status: "authorized",
      runId: options.runId,
      agentId: "repairer",
      toolCallId: context.callId,
      metadata: {
        path: inputPath,
        operation,
        tool,
        fingerprint,
        dryRun: options.dryRun,
      },
    });
    const result = await execute();
    changes.push({
      pass: options.currentPass(),
      role: "repairer",
      callId: context.callId,
      tool,
      fingerprint,
      path: result.path,
      operation,
      beforeSha256: result.beforeSha256,
      afterSha256: result.afterSha256,
      bytes: result.bytes,
      dryRun: result.dryRun,
    });
    await options.trace.record({
      type: "mutation",
      status: "completed",
      runId: options.runId,
      agentId: "repairer",
      toolCallId: context.callId,
      metadata: {
        path: result.path,
        operation,
        tool,
        fingerprint,
        beforeSha256: result.beforeSha256,
        afterSha256: result.afterSha256,
        bytes: result.bytes,
        dryRun: result.dryRun,
      },
    });
    return result;
  };

  registry.register({
    name: "create_file",
    description: "Create one absent authorized UTF-8 file.",
    mutating: true,
    inputSchema: CreateInputSchema,
    execute: async (input, context) =>
      await recordMutation(
        "create_file",
        "create",
        input.path,
        input,
        context,
        async () => await filesystem.createFile.execute(input),
      ),
  });
  registry.register({
    name: "write_file",
    description: "Replace one authorized UTF-8 file after an observed SHA-256 precondition.",
    mutating: true,
    inputSchema: WriteInputSchema,
    execute: async (input, context) =>
      await recordMutation(
        "write_file",
        "update",
        input.path,
        input,
        context,
        async () => await filesystem.writeFile.execute(input),
      ),
  });
  registry.register({
    name: "apply_patch",
    description: "Apply a one-file unified diff after an observed SHA-256 precondition.",
    mutating: true,
    inputSchema: PatchInputSchema,
    execute: async (input, context) =>
      await recordMutation(
        "apply_patch",
        "update",
        input.path,
        input,
        context,
        async () => await filesystem.applyPatch.execute(input),
      ),
  });
  registry.register({
    name: "process_status",
    description: "Read status for the single workflow-owned command process.",
    mutating: false,
    inputSchema: EmptyInputSchema,
    execute: async () => options.processContext.readStatus(),
  });
  registry.register({
    name: "process_logs",
    description: "Read only the next bounded sanitized command log delta.",
    mutating: false,
    inputSchema: EmptyInputSchema,
    execute: async () => options.processContext.readLogDelta(),
  });

  return { registry, filesystem, changes };
}

export function statusMetadata(
  status: ProcessStatusSnapshot | undefined,
): Readonly<Record<string, unknown>> {
  if (status === undefined) return { status: "unknown" };
  return {
    commandId: status.commandId,
    pid: status.pid,
    status: status.status,
    startedAt: status.startedAt,
    updatedAt: status.updatedAt,
    exitCode: status.exitCode,
    signal: status.signal,
  };
}
