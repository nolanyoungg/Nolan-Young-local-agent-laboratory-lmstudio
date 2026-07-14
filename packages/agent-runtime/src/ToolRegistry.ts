import { createHash } from "node:crypto";
import { posix } from "node:path";
import { sanitizedError } from "@local-agent-lab/tracing";
import type { z } from "zod";
import type { AgentToolCallTurn } from "./StructuredResponseParser.js";
import type { ToolPermissionGuard } from "./ToolPermissionGuard.js";
import { AgentRuntimeError } from "./errors.js";

export interface ToolExecutionContext {
  readonly callId: string;
  readonly dryRun: boolean;
}

export interface ToolDefinition<TInput> {
  readonly name: string;
  readonly description: string;
  readonly mutating: boolean;
  readonly inputSchema: z.ZodType<TInput>;
  readonly execute: (input: TInput, context: ToolExecutionContext) => Promise<unknown>;
}

interface ErasedToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly mutating: boolean;
  readonly parse: (input: unknown) => unknown;
  readonly execute: (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
}

interface ToolExecutionResultBase {
  readonly callId: string;
  readonly tool: string;
  readonly cached: boolean;
  readonly replayed: boolean;
  readonly mutation: boolean;
  readonly fingerprint: string;
  readonly truncated: boolean;
  readonly beforeSha256?: string | null;
  readonly afterSha256?: string;
}

export interface ToolExecutionSuccessResult extends ToolExecutionResultBase {
  readonly status: "success";
  readonly output: unknown;
}

export interface ToolExecutionErrorResult extends ToolExecutionResultBase {
  readonly status: "error";
  readonly error: Readonly<{ name: string; message: string; code?: string }>;
}

export type ToolExecutionResult = ToolExecutionSuccessResult | ToolExecutionErrorResult;

export interface MutationJournalEntry {
  readonly callId: string;
  readonly tool: string;
  readonly fingerprint: string;
  readonly path?: string;
  readonly beforeSha256?: string | null;
  readonly afterSha256?: string;
  readonly dryRun?: boolean;
}

interface JournalEntry {
  readonly payloadHash: string;
  readonly result: ToolExecutionResult;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(normalize(value)))
    .digest("hex");
}

function normalizeOperationInput(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeOperationInput(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, item]) => [
        nestedKey,
        normalizeOperationInput(item, nestedKey),
      ]),
    );
  }
  if (typeof value === "string" && /(?:^|_)path$/iu.test(key ?? "")) {
    const portable = posix.normalize(value.replaceAll("\\", "/"));
    return process.platform === "win32" ? portable.toLowerCase() : portable;
  }
  return value;
}

function outputMetadata(output: unknown): Readonly<{
  truncated: boolean;
  beforeSha256?: string | null;
  afterSha256?: string;
}> {
  const record =
    typeof output === "object" && output !== null
      ? (output as Readonly<Record<string, unknown>>)
      : {};
  return {
    truncated: record["truncated"] === true,
    ...(typeof record["beforeSha256"] === "string" || record["beforeSha256"] === null
      ? { beforeSha256: record["beforeSha256"] }
      : {}),
    ...(typeof record["afterSha256"] === "string" ? { afterSha256: record["afterSha256"] } : {}),
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, ErasedToolDefinition>();
  private readonly calls = new Map<string, JournalEntry>();
  private readonly mutations = new Map<string, ToolExecutionSuccessResult>();

  public register<TInput>(definition: ToolDefinition<TInput>): void {
    if (this.tools.has(definition.name))
      throw new Error(`Tool ${definition.name} is already registered`);
    this.tools.set(definition.name, {
      name: definition.name,
      description: definition.description,
      mutating: definition.mutating,
      parse: (input) => definition.inputSchema.parse(input),
      execute: (input, context) => definition.execute(input as TInput, context),
    });
  }

  public definitions(): readonly Pick<ErasedToolDefinition, "description" | "mutating" | "name">[] {
    return [...this.tools.values()]
      .map(({ name, description, mutating }) => ({ name, description, mutating }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public mutationJournal(): readonly MutationJournalEntry[] {
    return [...this.mutations.values()].map((result) => {
      const output =
        typeof result.output === "object" && result.output !== null
          ? (result.output as Readonly<Record<string, unknown>>)
          : {};
      return {
        callId: result.callId,
        tool: result.tool,
        fingerprint: result.fingerprint,
        ...(typeof output["path"] === "string" ? { path: output["path"] } : {}),
        ...(typeof output["beforeSha256"] === "string" || output["beforeSha256"] === null
          ? { beforeSha256: output["beforeSha256"] }
          : {}),
        ...(typeof output["afterSha256"] === "string"
          ? { afterSha256: output["afterSha256"] }
          : {}),
        ...(typeof output["dryRun"] === "boolean" ? { dryRun: output["dryRun"] } : {}),
      };
    });
  }

  public async execute(
    call: AgentToolCallTurn,
    permissions: ToolPermissionGuard,
    dryRun: boolean,
  ): Promise<ToolExecutionResult> {
    permissions.assertAllowed(call.tool);
    const tool = this.tools.get(call.tool);
    if (tool === undefined) {
      throw new AgentRuntimeError("UNKNOWN_TOOL", `Unknown tool: ${call.tool}`, {
        tool: call.tool,
      });
    }
    let input: unknown;
    try {
      input = tool.parse(call.input);
    } catch (error) {
      throw new AgentRuntimeError(
        "INVALID_TOOL_INPUT",
        `Tool ${call.tool} input failed schema validation`,
        { callId: call.callId, tool: call.tool },
        { cause: error },
      );
    }
    const payloadHash = hash({ tool: call.tool, input, dryRun });
    const existingCall = this.calls.get(call.callId);
    if (existingCall !== undefined) {
      if (existingCall.payloadHash !== payloadHash) {
        throw new AgentRuntimeError(
          "DUPLICATE_CALL_ID_CONFLICT",
          `Call ID ${call.callId} was reused with different input`,
          { callId: call.callId },
        );
      }
      return { ...existingCall.result, cached: true, replayed: true };
    }

    const fingerprint = hash({
      tool: call.tool,
      input: normalizeOperationInput(input),
      dryRun,
      mutation: tool.mutating,
    });
    if (tool.mutating) {
      const existingMutation = this.mutations.get(fingerprint);
      if (existingMutation !== undefined) {
        const replay = { ...existingMutation, callId: call.callId, cached: true, replayed: true };
        this.calls.set(call.callId, { payloadHash, result: replay });
        return replay;
      }
    }

    let result: ToolExecutionResult;
    try {
      const output = await tool.execute(input, { callId: call.callId, dryRun });
      result = {
        callId: call.callId,
        tool: call.tool,
        status: "success",
        output,
        cached: false,
        replayed: false,
        mutation: tool.mutating,
        fingerprint,
        ...outputMetadata(output),
      };
    } catch (error) {
      result = {
        callId: call.callId,
        tool: call.tool,
        status: "error",
        error: sanitizedError(error),
        cached: false,
        replayed: false,
        mutation: tool.mutating,
        fingerprint,
        truncated: false,
      };
    }
    this.calls.set(call.callId, { payloadHash, result });
    if (tool.mutating && result.status === "success") {
      this.mutations.set(fingerprint, result);
    }
    return result;
  }
}
