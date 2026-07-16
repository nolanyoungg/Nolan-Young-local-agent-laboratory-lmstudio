import { z } from "zod";
import { AgentRuntimeError } from "./errors.js";

export interface AgentToolCallTurn {
  readonly kind: "tool_call";
  readonly callId: string;
  readonly tool: string;
  readonly input: unknown;
}

export type AgentCompleteTurn<TFinal extends Readonly<Record<string, unknown>>> = {
  readonly kind: "complete";
} & TFinal;

export type AgentTurn<TFinal extends Readonly<Record<string, unknown>>> =
  AgentToolCallTurn | AgentCompleteTurn<TFinal>;

const ToolCallTurnSchema = z
  .object({
    kind: z.literal("tool_call"),
    callId: z.string().min(1).max(128),
    tool: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    // Tool inputs are always JSON objects. `z.unknown()` is treated as optional
    // by Zod's JSON-schema conversion, producing an unconstrained `{}` member
    // that some constrained decoders cannot advance through. The concrete tool
    // schema remains the authority in ToolRegistry before execution.
    input: z.record(z.unknown()),
  })
  .strict();

/**
 * A deliberately flat JSON-schema envelope for LM Studio constrained decoding.
 * JSON Schema unions with dynamic tool inputs are not consistently supported by
 * local structured-output engines. The inner JSON strings are parsed and
 * strictly validated before any action is accepted.
 */
const ModelEnvelopeSchema = z
  .object({
    kind: z.enum(["tool_call", "complete"]),
    callId: z.string().max(128),
    tool: z.string().max(64),
    input: z.string().min(2),
    output: z.string().min(2),
  })
  .strict();

export interface StructuredToolSchema {
  readonly name: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly mutating?: boolean;
}

export interface ModelParseContext {
  readonly rawContent?: string;
  readonly harmonyCallId?: string;
}

const HARMONY_TOOL_CALL_PREFIX =
  /<\|channel\|>(?:analysis|commentary)\s+to=\s*(?:functions\.|tool_call_|tool[.:])?([a-z][a-z0-9_]{1,63})(?:\s+<\|constrain\|>json)?\s*<\|message\|>/gu;

function firstCompleteJsonValue(content: string, startAt: number): string | undefined {
  let start = -1;
  let stack: string[] = [];
  let quoted = false;
  let escaped = false;
  for (let index = startAt; index < content.length; index += 1) {
    const character = content[index];
    if (character === undefined) continue;
    if (start === -1) {
      if (character === "{" || character === "[") {
        start = index;
        stack = [character === "{" ? "}" : "]"];
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") stack.push("}");
    else if (character === "[") stack.push("]");
    else if (character === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return content.slice(start, index + 1);
    }
  }
  return undefined;
}

function parseEmbeddedJson(value: string): unknown {
  const parsed = JSON.parse(value) as unknown;
  return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
}

function toolCallSchema(tool: StructuredToolSchema): z.AnyZodObject {
  return z
    .object({
      kind: z.literal("tool_call"),
      callId: z.string().min(1).max(128),
      tool: z.literal(tool.name),
      input: tool.inputSchema,
    })
    .strict();
}

export class StructuredResponseParser<TFinal extends Readonly<Record<string, unknown>>> {
  /**
   * Agent turns are generated as ordinary JSON, then strictly validated below.
   * This intentionally avoids LM Studio's constrained grammar for a dynamic
   * tool union while preserving validation before any tool execution.
   */
  public readonly schema: z.ZodType<unknown>;
  private readonly validationSchema: z.ZodType<AgentTurn<TFinal>>;
  private readonly tools: readonly StructuredToolSchema[];

  public constructor(finalSchema: z.AnyZodObject, tools: readonly StructuredToolSchema[] = []) {
    this.tools = tools;
    this.validationSchema = this.createTurnSchema(finalSchema, tools);
    this.schema = ModelEnvelopeSchema;
  }

  private createTurnSchema(
    finalSchema: z.AnyZodObject,
    tools: readonly StructuredToolSchema[],
  ): z.ZodType<AgentTurn<TFinal>> {
    const toolSchemas = tools.length === 0 ? [ToolCallTurnSchema] : tools.map(toolCallSchema);
    return z.union([
      ...toolSchemas,
      finalSchema.extend({ kind: z.literal("complete") }).strict(),
    ] as unknown as [z.AnyZodObject, z.AnyZodObject, ...z.AnyZodObject[]]) as unknown as z.ZodType<
      AgentTurn<TFinal>
    >;
  }

  public parse(value: unknown, context: ModelParseContext = {}): AgentTurn<TFinal> {
    const envelope = ModelEnvelopeSchema.safeParse(value);
    const decoded = envelope.success ? this.decodeEnvelope(envelope.data) : value;
    const result = this.validationSchema.safeParse(decoded);
    if (result.success) return result.data;

    const genericHarmony = this.parseGenericHarmonyToolCall(value, context);
    if (genericHarmony !== undefined) {
      const genericHarmonyResult = this.validationSchema.safeParse(genericHarmony);
      if (genericHarmonyResult.success) return genericHarmonyResult.data;
    }

    const compatible = this.parseCompatibleJsonTurn(value, context.harmonyCallId);
    if (compatible !== undefined) {
      const compatibleResult = this.validationSchema.safeParse(compatible);
      if (compatibleResult.success) return compatibleResult.data;
    }

    const harmony = this.parseHarmonyToolCall(value, context);
    if (harmony !== undefined) {
      const harmonyResult = this.validationSchema.safeParse(harmony);
      if (harmonyResult.success) return harmonyResult.data;
      return this.invalid(harmonyResult.error.issues);
    }
    return this.invalid(result.error.issues);
  }

  private decodeEnvelope(envelope: z.infer<typeof ModelEnvelopeSchema>): unknown {
    try {
      if (envelope.kind === "tool_call") {
        let input: unknown;
        try {
          input = parseEmbeddedJson(envelope.input);
        } catch {
          input = envelope.input;
        }
        return {
          kind: "tool_call",
          callId: envelope.callId,
          tool: envelope.tool,
          input:
            typeof input === "string" &&
            (envelope.tool === "read_file" || envelope.tool === "read_file_metadata")
              ? { path: input }
              : input,
        };
      }
      const output = parseEmbeddedJson(envelope.output);
      return typeof output === "object" && output !== null && !Array.isArray(output)
        ? { kind: "complete", ...output }
        : envelope;
    } catch {
      return envelope;
    }
  }

  public matchingToolNames(value: unknown): readonly string[] {
    const record =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : undefined;
    if (record === undefined) return [];
    const input = record["input"] ?? record;
    return this.tools
      .filter((tool) => tool.inputSchema.safeParse(input).success)
      .map((tool) => tool.name)
      .sort();
  }

  private parseGenericHarmonyToolCall(
    value: unknown,
    context: ModelParseContext,
  ): AgentToolCallTurn | undefined {
    if (context.rawContent === undefined || context.harmonyCallId === undefined) return undefined;
    return /<\|channel\|>(?:analysis|commentary)\s+to=\s*tool_call\b/u.test(context.rawContent)
      ? this.inferGenericHarmonyToolCall(value, context.harmonyCallId)
      : undefined;
  }

  private parseHarmonyToolCall(
    value: unknown,
    context: ModelParseContext,
  ): AgentToolCallTurn | undefined {
    if (context.rawContent === undefined || context.harmonyCallId === undefined) return undefined;
    const content = context.rawContent.trim();
    const matches = [...content.matchAll(HARMONY_TOOL_CALL_PREFIX)];
    const match = matches.at(-1);
    if (match === undefined) return undefined;
    const recipient = match[1];
    if (recipient === "tool_call") {
      const parsedCall = this.inferGenericHarmonyToolCall(value, context.harmonyCallId);
      if (parsedCall !== undefined) return parsedCall;
    }
    const inputText = firstCompleteJsonValue(content, (match.index ?? 0) + match[0].length);
    if (recipient === undefined || inputText === undefined) return undefined;
    try {
      const payload = JSON.parse(inputText) as unknown;
      if (recipient !== "tool_call") {
        return {
          kind: "tool_call",
          callId: context.harmonyCallId,
          tool: recipient,
          input: payload,
        };
      }
      return this.inferGenericHarmonyToolCall(payload, context.harmonyCallId);
    } catch {
      return undefined;
    }
  }

  /**
   * GPT-OSS occasionally emits the Harmony recipient `tool_call` without a
   * tool name. Infer one only when exactly one tool permitted for this role
   * accepts the input. Ambiguous and unknown calls remain invalid.
   */
  private inferGenericHarmonyToolCall(
    payload: unknown,
    callId: string,
  ): AgentToolCallTurn | undefined {
    const record =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Readonly<Record<string, unknown>>)
        : undefined;
    if (record === undefined) return undefined;
    const input = record["input"] ?? record;
    const inputRecord =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as Readonly<Record<string, unknown>>)
        : undefined;
    const readOnlyHint =
      inputRecord !== undefined && ("recursive" in inputRecord || "maxResults" in inputRecord)
        ? this.tools.find(
            (candidate) => candidate.name === "list_files" && candidate.mutating !== true,
          )
        : undefined;
    const lineReadHint =
      inputRecord !== undefined &&
      ("startLine" in inputRecord || "endLine" in inputRecord || "maxOutputBytes" in inputRecord)
        ? this.tools.find(
            (candidate) => candidate.name === "read_file" && candidate.mutating !== true,
          )
        : undefined;
    const toolHint = readOnlyHint ?? lineReadHint;
    if (toolHint !== undefined) {
      return { kind: "tool_call", callId, tool: toolHint.name, input };
    }
    const matches = this.tools.filter((tool) => tool.inputSchema.safeParse(input).success);
    const singleMatch = matches.length === 1 ? matches[0] : undefined;
    const readOnlyFallback =
      matches.length > 1 && matches.every((candidate) => candidate.mutating !== true)
        ? matches.find((candidate) => candidate.name === "read_file")
        : undefined;
    const tool = singleMatch ?? readOnlyFallback;
    if (tool === undefined) return undefined;
    return { kind: "tool_call", callId, tool: tool.name, input };
  }

  private parseCompatibleJsonTurn(
    value: unknown,
    generatedCallId: string | undefined,
  ): Readonly<Record<string, unknown>> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Readonly<Record<string, unknown>>;
    if (record["kind"] !== undefined) return undefined;
    if (generatedCallId !== undefined) {
      const tool = record["tool"] ?? record["name"];
      const input = record["input"] ?? record["arguments"];
      if (typeof tool === "string" && typeof input === "object" && input !== null) {
        return { kind: "tool_call", callId: generatedCallId, tool, input };
      }
    }
    return { ...record, kind: "complete" };
  }

  private invalid(issues: readonly z.ZodIssue[]): never {
    throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "Model response failed validation", {
      issues: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
}
