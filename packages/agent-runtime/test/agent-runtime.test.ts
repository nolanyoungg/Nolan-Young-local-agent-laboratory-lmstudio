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
  public constructor(private readonly responses: unknown[]) {}

  public async complete<T>(
    _request: RuntimeModelRequest,
    outputSchema: z.ZodType<T>,
  ): Promise<RuntimeModelResponse<T>> {
    const response = this.responses.shift();
    const direct = outputSchema.safeParse(response);
    if (direct.success) return { parsed: direct.data, content: JSON.stringify(response) };
    if (typeof response !== "object" || response === null || Array.isArray(response)) {
      throw direct.error;
    }
    const parsed = outputSchema.parse({
      kind: (response as { kind?: unknown }).kind,
      payload: JSON.stringify(
        Object.fromEntries(
          Object.entries(response as Record<string, unknown>).filter(([key]) => key !== "kind"),
        ),
      ),
    });
    return { parsed, content: JSON.stringify(response) };
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

  it("unwraps the compact model wire envelope before strict local validation", () => {
    const parser = new StructuredResponseParser(finalSchema, [
      { name: "read_file", inputSchema: z.object({ path: z.string() }).strict() },
    ]);
    expect(
      parser.parse({
        kind: "tool_call",
        payload: JSON.stringify({ callId: "wire-one", tool: "read_file", input: { path: "a.ts" } }),
      }),
    ).toEqual({
      kind: "tool_call",
      callId: "wire-one",
      tool: "read_file",
      input: { path: "a.ts" },
    });
    expect(() =>
      parser.parse({ kind: "complete", payload: JSON.stringify({ summary: "missing" }) }),
    ).toThrow(AgentRuntimeError);
  });

  it("repairs a malformed wire response without executing a tool", async () => {
    const tools = new ToolRegistry();
    const client = new ScriptedClient([
      { kind: "complete", payload: "{}" },
      { kind: "complete", summary: "recovered", evidence: [], findings: [] },
    ]);
    const result = await baseLoop(client, tools).run();
    expect(result.toolCalls).toBe(0);
    expect(result.final["summary"]).toBe("recovered");
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
