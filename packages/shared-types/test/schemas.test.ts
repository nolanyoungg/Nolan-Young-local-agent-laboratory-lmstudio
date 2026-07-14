import { describe, expect, it } from "vitest";

import {
  ApplicationConfigSchema,
  DEFAULT_LM_STUDIO_BASE_URL,
  LMStudioConnectionConfigSchema,
  ModelCompletionRequestSchema,
  ModelTokenUsageSchema,
  StructuredErrorSchema,
  ToolCallSchema,
  ToolResultSchema,
  TraceEventSchema,
  WorkflowResultSchema,
} from "../src/index.js";

const CALL_ID = "2ee75f35-9df1-4b85-9417-320b78d4c3f8";
const RUN_ID = "4cd7ed58-8876-4453-85e8-641c38acbd2f";

describe("shared runtime schemas", () => {
  it("applies conservative LM Studio defaults", () => {
    const config = LMStudioConnectionConfigSchema.parse({});
    expect(config.baseUrl).toBe(DEFAULT_LM_STUDIO_BASE_URL);
    expect(config.requestTimeoutMs).toBe(300_000);
    expect(config.maxRetries).toBe(2);
    expect(config.contextTokens).toBe(32_768);
  });

  it.each([
    "http://192.168.1.12:1234",
    "http://example.com:1234",
    "ftp://127.0.0.1:1234",
    "http://user:secret@127.0.0.1:1234",
  ])("rejects unsafe LM Studio endpoint %s", (baseUrl) => {
    expect(() => LMStudioConnectionConfigSchema.parse({ baseUrl })).toThrow();
  });

  it("parses a discriminated tool call and rejects arbitrary actions", () => {
    expect(
      ToolCallSchema.parse({
        id: CALL_ID,
        name: "read_file",
        arguments: { path: "src/index.ts" },
      }).name,
    ).toBe("read_file");
    expect(
      ToolCallSchema.safeParse({ id: CALL_ID, name: "delete_everything", arguments: {} }).success,
    ).toBe(false);
    expect(
      ToolCallSchema.safeParse({
        id: CALL_ID,
        name: "read_file",
        arguments: { path: "src/index.ts", unexpected: true },
      }).success,
    ).toBe(false);
  });

  it("uses discriminated success and error tool results", () => {
    const success = ToolResultSchema.parse({
      status: "success",
      callId: CALL_ID,
      toolName: "read_file",
      output: { content: "ok" },
      durationMs: 4,
    });
    const failure = ToolResultSchema.parse({
      status: "error",
      callId: CALL_ID,
      toolName: "read_file",
      error: {
        name: "ReadError",
        code: "READ_FAILED",
        category: "filesystem",
        message: "Unable to read file",
      },
      durationMs: 4,
    });
    expect(success.status).toBe("success");
    expect(failure.status).toBe("error");
  });

  it("validates model requests and token accounting", () => {
    const request = ModelCompletionRequestSchema.parse({
      requestId: CALL_ID,
      model: "qwen-coder",
      messages: [{ role: "user", content: "Inspect src/index.ts" }],
    });
    expect(request.responseFormat).toEqual({ type: "text" });
    expect(
      ModelTokenUsageSchema.safeParse({ inputTokens: 10, outputTokens: 5, totalTokens: 14 })
        .success,
    ).toBe(false);
  });

  it("validates trace and workflow contracts", () => {
    expect(
      TraceEventSchema.safeParse({
        eventId: CALL_ID,
        runId: RUN_ID,
        sequence: 0,
        timestamp: "2026-07-13T12:00:00.000Z",
        type: "tool.request",
        payload: { id: CALL_ID, name: "list_files", arguments: {} },
      }).success,
    ).toBe(true);
    expect(
      WorkflowResultSchema.safeParse({
        workflowId: "code-editor",
        runId: RUN_ID,
        status: "succeeded",
        mode: "dry-run",
        summary: "No changes were required.",
        startedAt: "2026-07-13T12:00:00.000Z",
        endedAt: "2026-07-13T12:00:01.000Z",
      }).success,
    ).toBe(true);
  });

  it("uses safe application defaults", () => {
    const config = ApplicationConfigSchema.parse({
      workspace: "examples/sample-node-project",
      task: "Review the project",
    });
    expect(config.mode).toBe("dry-run");
    expect(config.maxAgentSteps).toBe(20);
    expect(config.maxRepairPasses).toBe(3);
  });

  it("rejects unknown structured error fields", () => {
    expect(
      StructuredErrorSchema.safeParse({
        name: "SecurityError",
        code: "DENIED",
        category: "security",
        message: "Denied",
        secret: "must-not-pass",
      }).success,
    ).toBe(false);
  });
});
