import type {
  RuntimeModelClient,
  RuntimeModelRequest,
  RuntimeModelResponse,
} from "@local-agent-lab/agent-runtime";
import {
  MockModelClient,
  createLMStudioModelClient,
  type LocalModelClient,
} from "@local-agent-lab/local-model-client";
import type { z } from "zod";

import type { CodeEditorConfig } from "./Configuration.js";
import type { CodeEditorMode } from "./types.js";

export class RuntimeLocalModelAdapter implements RuntimeModelClient {
  public constructor(
    public readonly client: LocalModelClient,
    private readonly signal?: AbortSignal,
  ) {}

  public async complete<T>(
    request: RuntimeModelRequest,
    outputSchema: z.ZodType<T>,
  ): Promise<RuntimeModelResponse<T>> {
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
    return {
      parsed: response.value,
      content: response.content,
      model: response.model,
    };
  }
}

export function createCodeEditorModelClient(config: CodeEditorConfig): LocalModelClient {
  if (config.mock) {
    return new MockModelClient({ responses: deterministicMockScript(config.mode) });
  }
  return createLMStudioModelClient({
    environment: config.environment,
    config: {
      requestedModel: config.requestedModel,
      contextLength: config.contextTokens,
      temperature: config.temperature,
      maxTokens: config.maxOutputTokens,
    },
  });
}

export function deterministicMockScript(mode: CodeEditorMode): readonly unknown[] {
  const planner = [
    {
      kind: "tool_call",
      callId: "mock-planner-list",
      tool: "list_files",
      input: { path: ".", recursive: true, maxResults: 100 },
    },
    {
      kind: "complete",
      summary: "The deterministic mock inspected the workspace and found no required edits.",
      evidence: ["The workspace listing completed through the confined read tool."],
      findings: [],
      changePlan: [],
    },
  ];
  if (mode === "plan-only") {
    return planner;
  }
  return [
    ...planner,
    {
      kind: "tool_call",
      callId: "mock-editor-list",
      tool: "list_files",
      input: { path: ".", recursive: true, maxResults: 100 },
    },
    {
      kind: "complete",
      summary: "No mutation was necessary for the deterministic mock task.",
      evidence: ["The editor used only the confined workspace listing."],
      findings: [],
      changedFiles: [],
    },
    {
      kind: "tool_call",
      callId: "mock-reviewer-list",
      tool: "list_files",
      input: { path: ".", recursive: true, maxResults: 100 },
    },
    {
      kind: "complete",
      summary: "The deterministic no-change proposal is internally consistent.",
      evidence: ["The reviewer independently listed the confined workspace."],
      findings: [],
      approved: true,
      requiredChanges: [],
    },
  ];
}
