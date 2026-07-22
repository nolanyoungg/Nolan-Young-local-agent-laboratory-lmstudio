import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  AgentLoop,
  AgentRuntimeError,
  StepLimiter,
  StructuredResponseParser,
  ToolPermissionGuard,
  ToolRegistry,
  ContextBudget,
  ConversationState,
  type RuntimeModelClient,
  type RuntimeModelRequest,
  type RuntimeModelResponse,
} from "../src/index.js";

class ScriptedClient implements RuntimeModelClient {
  public readonly requests: RuntimeModelRequest[] = [];

  public constructor(private readonly responses: unknown[]) {}

  public async complete<T>(
    request: RuntimeModelRequest,
    _outputSchema: z.ZodType<T>,
  ): Promise<RuntimeModelResponse<T>> {
    this.requests.push(request);
    const response = this.responses.shift();
    return { parsed: response as T, content: JSON.stringify(response) };
  }
}

class TraceCollector {
  public readonly events: Array<Readonly<Record<string, unknown>>> = [];

  public async record(event: Readonly<Record<string, unknown>>): Promise<void> {
    this.events.push(event);
  }
}

const finalSchema = z.object({
  summary: z.string(),
  evidence: z.array(z.string()),
  findings: z.array(z.string()),
});

function baseLoop(
  modelClient: RuntimeModelClient,
  tools: ToolRegistry,
): AgentLoop<Record<string, unknown>> {
  return new AgentLoop({
    runId: "run",
    agentId: "agent",
    systemPrompt: "Use tools and report evidence.",
    task: "Inspect the project.",
    model: "mock",
    temperature: 0,
    contextTokens: 8192,
    maxOutputTokens: 512,
    maximumSteps: 5,
    allowedTools: ["read_file", "write_file"],
    finalSchema,
    dryRun: false,
    modelClient,
    tools,
  });
}

describe("agent runtime", () => {
  it("runs a successful tool loop", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "read_file",
      description: "read",
      mutating: false,
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => ({ path, content: "hello" }),
    });
    const client = new ScriptedClient([
      { kind: "tool_call", callId: "one", tool: "read_file", input: { path: "a.ts" } },
      { kind: "complete", summary: "done", evidence: ["a.ts"], findings: [] },
    ]);
    const result = await baseLoop(client, tools).run();
    expect(result.toolCalls).toBe(1);
    expect(result.final["summary"]).toBe("done");
  });

  it("normalizes conflicting model call IDs before they reach the registry", async () => {
    const paths: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "read_file",
      description: "read",
      mutating: false,
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        paths.push(path);
        return { path, content: "hello" };
      },
    });
    const client = new ScriptedClient([
      { kind: "tool_call", callId: "1", tool: "read_file", input: { path: "a.ts" } },
      { kind: "tool_call", callId: "1", tool: "read_file", input: { path: "b.ts" } },
      { kind: "complete", summary: "done", evidence: ["a.ts", "b.ts"], findings: [] },
    ]);
    const result = await baseLoop(client, tools).run();
    expect(result.toolCalls).toBe(2);
    expect(paths).toEqual(["a.ts", "b.ts"]);
  });

  it("scopes model call IDs by agent role when loops share one registry", async () => {
    const paths: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "read_file",
      description: "read",
      mutating: false,
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        paths.push(path);
        return { path, content: "ok" };
      },
    });
    const createLoop = (agentId: string, path: string) =>
      new AgentLoop({
        runId: "shared-run",
        agentId,
        systemPrompt: "Use tools.",
        task: "Inspect.",
        model: "mock",
        temperature: 0,
        contextTokens: 8192,
        maxOutputTokens: 512,
        maximumSteps: 2,
        allowedTools: ["read_file"],
        finalSchema,
        dryRun: true,
        modelClient: new ScriptedClient([
          { kind: "tool_call", callId: "1", tool: "read_file", input: { path } },
          { kind: "complete", summary: "done", evidence: [path], findings: [] },
        ]),
        tools,
      });

    await createLoop("diagnostician", "build.log").run();
    await createLoop("repairer", "src/index.ts").run();
    expect(paths).toEqual(["build.log", "src/index.ts"]);
  });

  it("anchors the observed read hash before a model can propose a mutation", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "read_file",
      description: "read",
      mutating: false,
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => ({ path, sha256: "a".repeat(64), content: "source" }),
    });
    const client = new ScriptedClient([
      { kind: "tool_call", callId: "read", tool: "read_file", input: { path: "a.ts" } },
      { kind: "complete", summary: "done", evidence: ["a.ts"], findings: [] },
    ]);
    await baseLoop(client, tools).run();
    expect(client.requests[1]?.messages.map((message) => message.content).join("\n")).toContain(
      "Any later write_file or apply_patch for this path must copy this exact value",
    );
  });

  it("requires a fresh read after a failed patch before allowing a corrective mutation", async () => {
    let patchAttempts = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "read_file",
      description: "read",
      mutating: false,
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => ({ path, sha256: "b".repeat(64), content: "source" }),
    });
    tools.register({
      name: "apply_patch",
      description: "patch",
      mutating: true,
      inputSchema: z.object({ path: z.string(), patch: z.string(), expectedSha256: z.string() }),
      execute: async () => {
        patchAttempts += 1;
        if (patchAttempts === 1) throw new Error("patch context did not match");
        return { path: "a.ts", beforeSha256: "b".repeat(64), afterSha256: "c".repeat(64) };
      },
    });
    const client = new ScriptedClient([
      {
        kind: "tool_call",
        callId: "patch-1",
        tool: "apply_patch",
        input: { path: "a.ts", patch: "@@", expectedSha256: "a".repeat(64) },
      },
      { kind: "tool_call", callId: "read", tool: "read_file", input: { path: "a.ts" } },
      {
        kind: "tool_call",
        callId: "patch-2",
        tool: "apply_patch",
        input: { path: "a.ts", patch: "@@", expectedSha256: "b".repeat(64) },
      },
      { kind: "complete", summary: "done", evidence: ["a.ts"], findings: [] },
    ]);
    const loop = new AgentLoop({
      runId: "patch-recovery",
      agentId: "editor",
      systemPrompt: "Use tools.",
      task: "Repair.",
      model: "mock",
      temperature: 0,
      contextTokens: 8192,
      maxOutputTokens: 512,
      maximumSteps: 5,
      allowedTools: ["read_file", "apply_patch"],
      finalSchema,
      dryRun: true,
      modelClient: client,
      tools,
    });
    await loop.run();
    expect(patchAttempts).toBe(2);
    expect(client.requests[1]?.messages.map((message) => message.content).join("\n")).toContain(
      "PATCH RECOVERY",
    );
  });

  it("fails safely when the corrective patch attempt also fails", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "read_file",
      description: "read",
      mutating: false,
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => ({ path, sha256: "b".repeat(64), content: "source" }),
    });
    tools.register({
      name: "apply_patch",
      description: "patch",
      mutating: true,
      inputSchema: z.object({ path: z.string(), patch: z.string(), expectedSha256: z.string() }),
      execute: async () => {
        throw new Error("patch context did not match");
      },
    });
    const loop = new AgentLoop({
      runId: "failed-patch-recovery",
      agentId: "editor",
      systemPrompt: "Use tools.",
      task: "Repair.",
      model: "mock",
      temperature: 0,
      contextTokens: 8192,
      maxOutputTokens: 512,
      maximumSteps: 4,
      allowedTools: ["read_file", "apply_patch"],
      finalSchema,
      dryRun: true,
      modelClient: new ScriptedClient([
        {
          kind: "tool_call",
          callId: "patch-1",
          tool: "apply_patch",
          input: { path: "a.ts", patch: "@@", expectedSha256: "a".repeat(64) },
        },
        { kind: "tool_call", callId: "read", tool: "read_file", input: { path: "a.ts" } },
        {
          kind: "tool_call",
          callId: "patch-2",
          tool: "apply_patch",
          input: { path: "a.ts", patch: "@@", expectedSha256: "b".repeat(64) },
        },
      ]),
      tools,
    });
    await expect(loop.run()).rejects.toMatchObject({ code: "TOOL_EXECUTION_FAILED" });
  });

  it("deduplicates repeated mutations under new call IDs", async () => {
    let writes = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "write_file",
      description: "write",
      mutating: true,
      inputSchema: z.object({ path: z.string(), expectedHash: z.string(), content: z.string() }),
      execute: async () => {
        writes += 1;
        return { changed: true };
      },
    });
    const guard = new ToolPermissionGuard(["write_file"]);
    await tools.execute(
      {
        kind: "tool_call",
        callId: "one",
        tool: "write_file",
        input: { path: "a", expectedHash: "h", content: "x" },
      },
      guard,
      false,
    );
    const replay = await tools.execute(
      {
        kind: "tool_call",
        callId: "two",
        tool: "write_file",
        input: { path: "a", expectedHash: "h", content: "x" },
      },
      guard,
      false,
    );
    expect(writes).toBe(1);
    expect(replay.replayed).toBe(true);
  });

  it("normalizes portable paths for mutation fingerprints", async () => {
    let writes = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "write_file",
      description: "write",
      mutating: true,
      inputSchema: z
        .object({ path: z.string(), expectedSha256: z.string(), content: z.string() })
        .strict(),
      execute: async () => {
        writes += 1;
        return { path: "folder/a.ts", beforeSha256: "a".repeat(64), afterSha256: "b".repeat(64) };
      },
    });
    const guard = new ToolPermissionGuard(["write_file"]);
    const input = { expectedSha256: "a".repeat(64), content: "next" };
    await tools.execute(
      {
        kind: "tool_call",
        callId: "slash-one",
        tool: "write_file",
        input: { ...input, path: "folder\\a.ts" },
      },
      guard,
      true,
    );
    const replay = await tools.execute(
      {
        kind: "tool_call",
        callId: "slash-two",
        tool: "write_file",
        input: { ...input, path: "folder/a.ts" },
      },
      guard,
      true,
    );
    expect(writes).toBe(1);
    expect(replay.replayed).toBe(true);
  });

  it("rejects call-ID conflicts and invalid tool inputs before execution", async () => {
    let executions = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "read_file",
      description: "read",
      mutating: false,
      inputSchema: z.object({ path: z.string() }).strict(),
      execute: async () => {
        executions += 1;
        return { content: "ok" };
      },
    });
    const guard = new ToolPermissionGuard(["read_file"]);
    await tools.execute(
      { kind: "tool_call", callId: "same", tool: "read_file", input: { path: "a.ts" } },
      guard,
      false,
    );
    await expect(
      tools.execute(
        { kind: "tool_call", callId: "same", tool: "read_file", input: { path: "b.ts" } },
        guard,
        false,
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_CALL_ID_CONFLICT" });
    await expect(
      tools.execute(
        {
          kind: "tool_call",
          callId: "invalid",
          tool: "read_file",
          input: { path: "a.ts", executable: "forbidden" },
        },
        guard,
        false,
      ),
    ).rejects.toMatchObject({ code: "INVALID_TOOL_INPUT" });
    expect(executions).toBe(1);
  });

  it("returns sanitized typed tool failures and replays a repeated call without execution", async () => {
    let executions = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "read_file",
      description: "read",
      mutating: false,
      inputSchema: z.object({ path: z.string() }).strict(),
      execute: async () => {
        executions += 1;
        throw Object.assign(new Error("read rejected"), { code: "READ_DENIED" });
      },
    });
    const guard = new ToolPermissionGuard(["read_file"]);
    const call = {
      kind: "tool_call" as const,
      callId: "failure",
      tool: "read_file",
      input: { path: "denied.txt" },
    };
    const first = await tools.execute(call, guard, false);
    const replay = await tools.execute(call, guard, false);
    expect(first).toMatchObject({
      status: "error",
      error: { code: "READ_DENIED", message: "read rejected" },
    });
    expect(replay).toMatchObject({ status: "error", cached: true, replayed: true });
    expect(executions).toBe(1);
  });

  it("rejects malformed turns and disallowed tools", () => {
    const parser = new StructuredResponseParser(finalSchema);
    expect(() => parser.parse({ kind: "tool_call", tool: "read_file" })).toThrow(AgentRuntimeError);
    expect(() => new ToolPermissionGuard([]).assertAllowed("read_file")).toThrow(AgentRuntimeError);
  });

  it("strictly validates a direct JSON tool turn before it reaches the registry", () => {
    const parser = new StructuredResponseParser(finalSchema, [
      { name: "read_file", inputSchema: z.object({ path: z.string() }).strict() },
    ]);
    expect(
      parser.parse({
        kind: "tool_call",
        callId: "direct-one",
        tool: "read_file",
        input: { path: "a.ts" },
      }),
    ).toEqual({
      kind: "tool_call",
      callId: "direct-one",
      tool: "read_file",
      input: { path: "a.ts" },
    });
    expect(() => parser.parse({ kind: "complete", summary: "missing" })).toThrow(AgentRuntimeError);
  });

  it("adapts a Harmony tool call before strict local validation", () => {
    const parser = new StructuredResponseParser(finalSchema, [
      {
        name: "list_files",
        inputSchema: z.object({ path: z.string(), recursive: z.boolean() }).strict(),
      },
    ]);
    expect(
      parser.parse(
        { path: ".", recursive: false },
        {
          harmonyCallId: "planner-1",
          rawContent:
            '<|channel|>analysis<|message|>inspect<|end|><|start|>assistant<|channel|>commentary to=tool_call_list_files <|constrain|>json<|message|>{"path":".","recursive":false}',
        },
      ),
    ).toEqual({
      kind: "tool_call",
      callId: "planner-1",
      tool: "list_files",
      input: { path: ".", recursive: false },
    });
  });

  it("adapts canonical gpt-oss Harmony calls with terminal control tokens", () => {
    const parser = new StructuredResponseParser(finalSchema, [
      {
        name: "read_file",
        inputSchema: z.object({ path: z.string() }).strict(),
      },
    ]);
    expect(
      parser.parse(
        { path: "ignored-parser-candidate.ts" },
        {
          harmonyCallId: "planner-2",
          rawContent:
            '<|start|>assistant<|channel|>analysis to=functions.read_file <|constrain|>json<|message|>{"path":"src/index.ts"}<|call|>',
        },
      ),
    ).toEqual({
      kind: "tool_call",
      callId: "planner-2",
      tool: "read_file",
      input: { path: "src/index.ts" },
    });
  });

  it("accepts LM Studio Harmony spacing around the recipient", () => {
    const parser = new StructuredResponseParser(finalSchema, [
      { name: "list_files", inputSchema: z.object({ path: z.string() }).strict() },
    ]);
    expect(
      parser.parse(
        { path: "." },
        {
          harmonyCallId: "planner-spaced",
          rawContent:
            '<|channel|>analysis to= list_files <|constrain|>json<|message|>{"path":"."}<|call|>',
        },
      ),
    ).toMatchObject({ tool: "list_files", input: { path: "." } });
  });

  it("infers an unambiguously shaped generic GPT-OSS Harmony tool call", () => {
    const parser = new StructuredResponseParser(finalSchema, [
      {
        name: "list_files",
        inputSchema: z
          .object({ path: z.string(), recursive: z.boolean(), maxResults: z.number() })
          .strict(),
      },
      {
        name: "read_file",
        inputSchema: z
          .object({ path: z.string(), startLine: z.number(), endLine: z.number() })
          .strict(),
      },
    ]);
    expect(
      parser.parse(
        { kind: "tool_call", input: { path: ".", recursive: true, maxResults: 100 } },
        {
          harmonyCallId: "planner-generic",
          rawContent:
            '<|channel|>analysis to=tool_call <|constrain|>json<|message|>{"kind":"tool_call","input":{"path":".","recursive":true,"maxResults":100}}<|call|>',
        },
      ),
    ).toEqual({
      kind: "tool_call",
      callId: "planner-generic",
      tool: "list_files",
      input: { path: ".", recursive: true, maxResults: 100 },
    });
  });

  it("uses LM Studio's parsed generic arguments before the raw Harmony payload", () => {
    const parser = new StructuredResponseParser(finalSchema, [
      {
        name: "list_files",
        inputSchema: z
          .object({ path: z.string(), recursive: z.boolean(), maxResults: z.number() })
          .strict(),
      },
      { name: "read_file", inputSchema: z.object({ path: z.string() }).strict() },
    ]);
    expect(
      parser.parse(
        { path: ".", recursive: true, maxResults: 100 },
        {
          harmonyCallId: "planner-parsed",
          rawContent:
            '<|channel|>analysis to=tool_call <|constrain|>json<|message|>{"unusable":"raw payload"}<|call|>',
        },
      ),
    ).toMatchObject({
      tool: "list_files",
      input: { path: ".", recursive: true, maxResults: 100 },
    });
  });

  it("uses parsed generic arguments when the raw Harmony payload is incomplete", () => {
    const parser = new StructuredResponseParser(finalSchema, [
      { name: "read_file", inputSchema: z.object({ path: z.string() }).strict() },
    ]);
    expect(
      parser.parse(
        { path: "src/index.ts" },
        {
          harmonyCallId: "planner-incomplete",
          rawContent: "<|channel|>analysis to=tool_call <|constrain|>json<|message|><|call|>",
        },
      ),
    ).toMatchObject({ tool: "read_file", input: { path: "src/index.ts" } });
  });

  it("uses the standard read tool only when an ambiguous generic call is read-only", () => {
    const parser = new StructuredResponseParser(finalSchema, [
      { name: "read_file", inputSchema: z.object({ path: z.string() }).strict(), mutating: false },
      {
        name: "read_file_metadata",
        inputSchema: z.object({ path: z.string() }).strict(),
        mutating: false,
      },
    ]);
    expect(
      parser.parse(
        { path: "src/index.ts" },
        {
          harmonyCallId: "editor-read",
          rawContent:
            '<|channel|>analysis to=tool_call <|constrain|>json<|message|>{"path":"src/index.ts"}<|call|>',
        },
      ),
    ).toMatchObject({ tool: "read_file", input: { path: "src/index.ts" } });
  });

  it("rejects generic Harmony calls that match multiple allowed tools", () => {
    const parser = new StructuredResponseParser(finalSchema, [
      { name: "read_file", inputSchema: z.object({ path: z.string() }).strict(), mutating: false },
      { name: "write_file", inputSchema: z.object({ path: z.string() }).strict(), mutating: true },
    ]);
    expect(() =>
      parser.parse(
        { kind: "tool_call", input: { path: "src/index.ts" } },
        {
          harmonyCallId: "ambiguous-generic",
          rawContent:
            '<|channel|>analysis to=tool_call <|constrain|>json<|message|>{"kind":"tool_call","input":{"path":"src/index.ts"}}<|call|>',
        },
      ),
    ).toThrow(AgentRuntimeError);
  });

  it("accepts the tool-prefixed Harmony recipient emitted by LM Studio", () => {
    const parser = new StructuredResponseParser(finalSchema, [
      { name: "read_file", inputSchema: z.object({ path: z.string() }).strict() },
    ]);
    expect(
      parser.parse(
        { path: "src/index.ts" },
        {
          harmonyCallId: "tool-prefixed",
          rawContent:
            '<|channel|>analysis to=tool:read_file <|constrain|>json<|message|>{"path":"src/index.ts"}<|call|>',
        },
      ),
    ).toMatchObject({ tool: "read_file", input: { path: "src/index.ts" } });
  });

  it("accepts the dotted tool-prefixed Harmony recipient emitted by GPT-OSS", () => {
    const parser = new StructuredResponseParser(finalSchema, [
      {
        name: "apply_patch",
        inputSchema: z
          .object({ path: z.string(), patch: z.string(), expectedSha256: z.string() })
          .strict(),
      },
    ]);
    expect(
      parser.parse(
        { path: "src/index.ts", patch: "@@", expectedSha256: "a".repeat(64) },
        {
          harmonyCallId: "tool-dotted",
          rawContent:
            '<|channel|>analysis to=tool.apply_patch <|constrain|>json<|message|>{"path":"src/index.ts","patch":"@@","expectedSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}<|call|>',
        },
      ),
    ).toMatchObject({ tool: "apply_patch", input: { path: "src/index.ts", patch: "@@" } });
  });

  it("normalizes safe abbreviated tool and completion envelopes", () => {
    const parser = new StructuredResponseParser(finalSchema, [
      { name: "read_file", inputSchema: z.object({ path: z.string() }).strict() },
    ]);
    expect(
      parser.parse(
        { name: "read_file", arguments: { path: "src/index.ts" } },
        { harmonyCallId: "generated-call" },
      ),
    ).toEqual({
      kind: "tool_call",
      callId: "generated-call",
      tool: "read_file",
      input: { path: "src/index.ts" },
    });
    expect(parser.parse({ summary: "done", evidence: [], findings: [] })).toEqual({
      kind: "complete",
      summary: "done",
      evidence: [],
      findings: [],
    });
  });

  it("fails once with protocol diagnostics for malformed model output", async () => {
    const tools = new ToolRegistry();
    const trace = new TraceCollector();
    const client = new ScriptedClient([{ unexpected: "shape" }]);
    const loop = new AgentLoop({
      runId: "diagnostics",
      agentId: "planner",
      systemPrompt: "Use tools.",
      task: "Inspect.",
      model: "mock",
      temperature: 0,
      contextTokens: 8192,
      maxOutputTokens: 512,
      maximumSteps: 3,
      allowedTools: [],
      finalSchema,
      dryRun: false,
      modelClient: client,
      tools,
      trace,
    });
    await expect(loop.run()).rejects.toMatchObject({ code: "MODEL_PROTOCOL_ERROR" });
    expect(client.requests).toHaveLength(1);
    const diagnostic = trace.events.find((event) => event["type"] === "model_protocol_error");
    expect(diagnostic?.["metadata"]).toMatchObject({
      errorCode: "INVALID_MODEL_RESPONSE",
      malformedOutputBytes: expect.any(Number),
    });
    expect(trace.events.some((event) => event["type"] === "model_response_repair")).toBe(false);
  });

  it("enforces the step limit", () => {
    const limiter = new StepLimiter(1);
    expect(limiter.next()).toBe(1);
    expect(() => limiter.next()).toThrowError(/exceeded/);
  });

  it("retains system, task, and latest error anchors while dropping old evidence", () => {
    const conversation = new ConversationState();
    conversation.append({ role: "system", content: "SYSTEM_ANCHOR", critical: true });
    conversation.append({ role: "user", content: "TASK_ANCHOR", critical: true });
    for (let index = 0; index < 50; index += 1) {
      conversation.append({ role: "tool", content: `OLD_${index}_${"x".repeat(1_000)}` });
    }
    conversation.append({ role: "tool", content: "LATEST_ERROR", critical: true });
    const messages = conversation.toModelMessages(new ContextBudget(8_192, 4_096));
    const content = messages.map((message) => message.content).join("\n");
    expect(content).toContain("SYSTEM_ANCHOR");
    expect(content).toContain("TASK_ANCHOR");
    expect(content).toContain("LATEST_ERROR");
    expect(content).not.toContain("OLD_0_");
  });
});
