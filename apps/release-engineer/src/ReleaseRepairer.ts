import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  AgentRunner,
  ToolRegistry,
  type MutationJournalEntry as RuntimeMutationJournalEntry,
  type RuntimeModelClient,
  type RuntimeModelRequest,
} from "@local-agent-lab/agent-runtime";
import {
  ApplyPatchInputSchema,
  CreateFileInputSchema,
  ListFilesInputSchema,
  ReadFileInputSchema,
  ReadFileMetadataInputSchema,
  SearchTextInputSchema,
  ToolFactory,
  WriteFileInputSchema,
  type FileMutationResult,
} from "@local-agent-lab/filesystem-tools";
import type { LocalModelClient } from "@local-agent-lab/local-model-client";
import type { TraceRecorder } from "@local-agent-lab/tracing";
import type { WorkspaceGuard } from "@local-agent-lab/workspace-security";
import { z, type ZodType } from "zod";

import { resolveApplicationLocations } from "./config.js";
import type { PermissionPolicy, ReleaseFinding, ReleaseMode } from "./types.js";

const HASH = z.string().regex(/^[a-f0-9]{64}$/u);
const SafeWriteFileInputSchema = WriteFileInputSchema.extend({ expectedSha256: HASH });

const RepairCompletionSchema = z
  .object({
    summary: z.string().min(1).max(8_192),
    evidence: z.array(z.string().min(1).max(2_048)).max(100),
    findings: z.array(z.string().min(1).max(2_048)).max(100),
    changedFiles: z.array(z.string().min(1).max(1_024)).max(100),
  })
  .strict();

type RepairCompletion = z.infer<typeof RepairCompletionSchema>;

const TOOL_PROTOCOL = `
Return exactly one JSON action per turn. Tool calls have
{"kind":"tool_call","callId":"unique-id","tool":"tool_name","input":{...}}.
Complete with {"kind":"complete","summary":"...","evidence":[],"findings":[],"changedFiles":[]}.
Available inputs:
- list_files: {path, recursive, maxResults}
- read_file: {path, startLine?, endLine?, maxOutputBytes?}
- read_file_metadata: {path}
- search_text: {path, query, caseSensitive, maxResults}
- create_file: {path, content}; the path must be absent
- write_file: {path, content, expectedSha256}; a previously observed hash is mandatory
- apply_patch: {path, patch, expectedSha256}; one-file unified diffs only
Never request deletion. Never access policy or application configuration.
`;

class LocalModelRuntimeAdapter implements RuntimeModelClient {
  public constructor(
    private readonly client: LocalModelClient,
    private readonly signal?: AbortSignal,
  ) {}

  public async complete<T>(
    request: RuntimeModelRequest,
    outputSchema: ZodType<T>,
  ): Promise<{ readonly parsed: T; readonly content: string; readonly model: string }> {
    const response = await this.client.complete(
      {
        messages: [...request.messages],
        model: request.model,
        temperature: request.temperature,
        maxTokens: request.maxOutputTokens,
        structuredOutput: false,
        ...(this.signal === undefined ? {} : { signal: this.signal }),
      },
      outputSchema,
    );
    return { parsed: response.value, content: response.content, model: response.model };
  }
}

export interface ReleaseRepairerOptions {
  readonly runId: string;
  readonly workspaceGuard: WorkspaceGuard;
  readonly mode: ReleaseMode;
  readonly permissions: PermissionPolicy;
  readonly modelClient: LocalModelClient;
  readonly requestedModel: string;
  readonly trace: TraceRecorder;
  readonly operatorTask: string;
  readonly signal?: AbortSignal;
}

export interface RepairRunResult {
  readonly summary: string;
  readonly mutationPaths: readonly string[];
  readonly overlay: ReadonlyMap<string, string>;
}

export interface MutationJournalEntry {
  readonly callId: string;
  readonly tool: string;
  readonly fingerprint: string;
  readonly path: string;
  readonly beforeSha256: string | null;
  readonly afterSha256: string;
  readonly dryRun: boolean;
}

function sanitizedJournalEntry(entry: RuntimeMutationJournalEntry): MutationJournalEntry {
  if (
    typeof entry.path !== "string" ||
    typeof entry.afterSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(entry.afterSha256) ||
    (entry.beforeSha256 !== null &&
      (typeof entry.beforeSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.beforeSha256))) ||
    typeof entry.dryRun !== "boolean"
  ) {
    throw new TypeError("Mutation tool returned invalid journal metadata.");
  }
  return {
    callId: entry.callId,
    tool: entry.tool,
    fingerprint: entry.fingerprint,
    path: entry.path,
    beforeSha256: entry.beforeSha256,
    afterSha256: entry.afterSha256,
    dryRun: entry.dryRun,
  };
}

export class ReleaseRepairer {
  readonly #options: ReleaseRepairerOptions;
  readonly #registry = new ToolRegistry();
  readonly #mutations: FileMutationResult[] = [];
  readonly #tools: ReturnType<typeof ToolFactory.create>;
  #systemPrompt: string | undefined;

  public constructor(options: ReleaseRepairerOptions) {
    this.#options = options;
    this.#tools = ToolFactory.create(options.workspaceGuard, {
      dryRun: options.mode === "dry-run",
    });
    this.#registerTools();
  }

  public get overlay(): ReadonlyMap<string, string> {
    return new Map(this.#tools.overlay.entries());
  }

  public get mutationJournal(): readonly MutationJournalEntry[] {
    return this.#registry.mutationJournal().map(sanitizedJournalEntry);
  }

  async #loadSystemPrompt(): Promise<string> {
    if (this.#systemPrompt !== undefined) return this.#systemPrompt;
    const { applicationRoot } = await resolveApplicationLocations();
    const base = await readFile(
      path.join(applicationRoot, "prompts", "repairer.system.md"),
      "utf8",
    );
    this.#systemPrompt = `${base.trim()}\n${TOOL_PROTOCOL}`;
    return this.#systemPrompt;
  }

  #registerTools(): void {
    const register = (
      name: string,
      description: string,
      mutating: boolean,
      inputSchema: ZodType<unknown>,
      execute: (input: unknown) => Promise<unknown>,
    ): void => {
      this.#registry.register({ name, description, mutating, inputSchema, execute });
    };
    const mutation = async (
      tool: string,
      execute: () => Promise<FileMutationResult>,
    ): Promise<FileMutationResult> => {
      await this.#options.trace.record({
        type: "mutation_preflight",
        status: "ready",
        runId: this.#options.runId,
        agentId: "release-repairer",
        metadata: { tool, mode: this.#options.mode },
      });
      const result = await execute();
      this.#mutations.push(result);
      return result;
    };

    register("list_files", "List bounded workspace paths.", false, ListFilesInputSchema, (input) =>
      this.#tools.listFiles.execute(input),
    );
    register("read_file", "Read bounded UTF-8 source lines.", false, ReadFileInputSchema, (input) =>
      this.#tools.readFile.execute(input),
    );
    register(
      "read_file_metadata",
      "Read file metadata and SHA-256.",
      false,
      ReadFileMetadataInputSchema,
      (input) => this.#tools.readFileMetadata.execute(input),
    );
    register(
      "search_text",
      "Search bounded workspace text.",
      false,
      SearchTextInputSchema,
      (input) => this.#tools.searchText.execute(input),
    );
    register("create_file", "Create an absent UTF-8 file.", true, CreateFileInputSchema, (input) =>
      mutation("create_file", () => this.#tools.createFile.execute(input)),
    );
    register(
      "write_file",
      "Replace an observed UTF-8 file.",
      true,
      SafeWriteFileInputSchema,
      (input) => mutation("write_file", () => this.#tools.writeFile.execute(input)),
    );
    register(
      "apply_patch",
      "Apply a one-file unified diff.",
      true,
      ApplyPatchInputSchema,
      (input) => mutation("apply_patch", () => this.#tools.applyPatch.execute(input)),
    );
  }

  public async run(pass: number, findings: readonly ReleaseFinding[]): Promise<RepairRunResult> {
    const startingMutationCount = this.#mutations.length;
    const task = [
      this.#options.operatorTask,
      `Repair pass ${pass} of at most 3. Deterministic checks remain authoritative.`,
      "Current deterministic findings:",
      JSON.stringify(
        findings.map(({ code, message, path }) => ({ code, message, path: path ?? null })),
      ),
    ].join("\n");
    const runner = new AgentRunner();
    await runner.run<RepairCompletion>(
      {
        id: "release-repairer",
        systemPrompt: await this.#loadSystemPrompt(),
        allowedTools: this.#options.permissions.repairer,
        finalSchema: RepairCompletionSchema,
      },
      {
        runId: this.#options.runId,
        task,
        model: this.#options.requestedModel,
        temperature: 0.1,
        contextTokens: 32_768,
        maxOutputTokens: 4_096,
        maximumSteps: 20,
        dryRun: this.#options.mode === "dry-run",
        modelClient: new LocalModelRuntimeAdapter(this.#options.modelClient, this.#options.signal),
        tools: this.#registry,
        trace: this.#options.trace,
      },
    );
    const newMutations = this.#mutations.slice(startingMutationCount);
    return {
      summary: `Repair agent completed pass ${pass} with ${newMutations.length} mutation${newMutations.length === 1 ? "" : "s"}.`,
      mutationPaths: [...new Set(newMutations.map((item) => item.path))].sort(),
      overlay: this.overlay,
    };
  }
}
