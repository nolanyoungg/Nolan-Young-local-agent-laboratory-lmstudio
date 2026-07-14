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

export interface StructuredToolSchema {
  readonly name: string;
  readonly inputSchema: z.ZodType<unknown>;
}

export interface ModelParseContext {
  readonly rawContent?: string;
  readonly harmonyCallId?: string;
}

const HARMONY_TOOL_CALL =
  /<\|channel\|>commentary\s+to=tool_call_([a-z][a-z0-9_]{1,63})\s+<\|constrain\|>json<\|message\|>(\{[\s\S]*\})$/u;

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
  public readonly schema: z.ZodType<unknown> = z.unknown();
  private readonly validationSchema: z.ZodType<AgentTurn<TFinal>>;

  public constructor(finalSchema: z.AnyZodObject, tools: readonly StructuredToolSchema[] = []) {
    this.validationSchema = this.createTurnSchema(finalSchema, tools);
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
    const result = this.validationSchema.safeParse(value);
    if (result.success) return result.data;

    const harmony = this.parseHarmonyToolCall(context);
    if (harmony !== undefined) {
      const harmonyResult = this.validationSchema.safeParse(harmony);
      if (harmonyResult.success) return harmonyResult.data;
      return this.invalid(harmonyResult.error.issues);
    }
    if (!result.success) {
      return this.invalid(result.error.issues);
    }
    return result.data;
  }

  private parseHarmonyToolCall(context: ModelParseContext): AgentToolCallTurn | undefined {
    if (context.rawContent === undefined || context.harmonyCallId === undefined) return undefined;
    const match = HARMONY_TOOL_CALL.exec(context.rawContent.trim());
    if (match === null) return undefined;
    const tool = match[1];
    const inputText = match[2];
    if (tool === undefined || inputText === undefined) return undefined;
    try {
      const input = JSON.parse(inputText) as unknown;
      return { kind: "tool_call", callId: context.harmonyCallId, tool, input };
    } catch {
      return undefined;
    }
  }

  private invalid(issues: readonly z.ZodIssue[]): never {
    throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "Model response failed validation", {
      issues: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
}
