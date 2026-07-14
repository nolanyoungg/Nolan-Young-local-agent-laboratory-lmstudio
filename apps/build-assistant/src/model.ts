import {
  type RuntimeModelClient,
  type RuntimeModelRequest,
  type RuntimeModelResponse,
} from "@local-agent-lab/agent-runtime";
import {
  type LocalModelClient,
  ModelClientError,
  ModelClientErrorCode,
} from "@local-agent-lab/local-model-client";
import type { ZodType } from "zod";

import { BuildAssistantError } from "./errors.js";

export class LocalRuntimeModelAdapter implements RuntimeModelClient {
  public constructor(
    private readonly client: LocalModelClient,
    private readonly signal?: AbortSignal,
  ) {}

  public async complete<T>(
    request: RuntimeModelRequest,
    outputSchema: ZodType<T>,
  ): Promise<RuntimeModelResponse<T>> {
    if (this.signal?.aborted === true) {
      throw new BuildAssistantError(
        "INTERRUPTED",
        "Model inference was interrupted.",
        "interrupted",
      );
    }
    const response = await this.client.complete(
      {
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        model: request.model,
        temperature: request.temperature,
        maxTokens: request.maxOutputTokens,
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

interface ToolEnvelope {
  readonly tool?: string;
  readonly output?: Readonly<Record<string, unknown>>;
}

function toolEnvelope(request: RuntimeModelRequest): ToolEnvelope | undefined {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message === undefined || !message.content.startsWith("TOOL RESULT\n")) continue;
    try {
      const parsed = JSON.parse(message.content.slice("TOOL RESULT\n".length)) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as ToolEnvelope;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function roleFrom(request: RuntimeModelRequest): "diagnostician" | "repairer" | "reviewer" {
  const system = request.messages.find((message) => message.role === "system")?.content ?? "";
  if (/diagnostician/iu.test(system)) return "diagnostician";
  if (/repairer/iu.test(system)) return "repairer";
  return "reviewer";
}

function repairContent(content: string): string {
  return content
    .replace(/return\s+input\s*;/u, "return Number(input);")
    .replace(/return\s+value\s*;/u, "return Number(value);");
}

/** Explicit deterministic mock used only when --mock is selected. */
export class BuildAssistantMockModelClient implements RuntimeModelClient {
  #callSequence = 0;

  public async complete<T>(
    request: RuntimeModelRequest,
    outputSchema: ZodType<T>,
  ): Promise<RuntimeModelResponse<T>> {
    const role = roleFrom(request);
    let value: unknown;
    if (role === "diagnostician") {
      value = {
        kind: "complete",
        summary: "The build reports a numeric parser returning an unconverted string value.",
        evidence: ["The bounded process failure identifies src/calculator.ts."],
        findings: ["Convert the string at the function boundary."],
        likelyFiles: ["src/calculator.ts"],
      };
    } else if (role === "reviewer") {
      value = {
        kind: "complete",
        summary: "The focused conversion is consistent with the declared numeric return type.",
        evidence: ["The repaired file is visible through the authorized workspace view."],
        findings: [],
        approved: true,
      };
    } else {
      const envelope = toolEnvelope(request);
      if (envelope === undefined) {
        value = {
          kind: "tool_call",
          callId: `mock-build-${++this.#callSequence}`,
          tool: "read_file",
          input: { path: "src/calculator.ts" },
        };
      } else if (envelope.tool === "read_file") {
        const output = envelope.output;
        const content = typeof output?.["content"] === "string" ? output["content"] : "";
        const sha256 = typeof output?.["sha256"] === "string" ? output["sha256"] : "";
        const path = typeof output?.["path"] === "string" ? output["path"] : "src/calculator.ts";
        const repaired = repairContent(content);
        if (repaired === content || !/^[a-f0-9]{64}$/u.test(sha256)) {
          value = {
            kind: "complete",
            summary: "No deterministic mock repair matched the fixture.",
            evidence: [path],
            findings: ["The mock only repairs the isolated calculator fixture."],
            changedFiles: [],
          };
        } else {
          value = {
            kind: "tool_call",
            callId: `mock-build-${++this.#callSequence}`,
            tool: "write_file",
            input: { path, content: repaired, expectedSha256: sha256 },
          };
        }
      } else {
        const output = envelope.output;
        const path = typeof output?.["path"] === "string" ? output["path"] : "src/calculator.ts";
        value = {
          kind: "complete",
          summary: "Applied the deterministic numeric conversion repair.",
          evidence: [path],
          findings: [],
          changedFiles: [path],
        };
      }
    }
    const parsed = outputSchema.safeParse(value);
    if (!parsed.success) {
      throw new ModelClientError(
        ModelClientErrorCode.malformedResponse,
        "The Build Assistant mock produced an invalid structured response.",
      );
    }
    return { parsed: parsed.data, content: JSON.stringify(parsed.data), model: "mock/coder" };
  }
}
