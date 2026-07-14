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
  public readonly schema: z.ZodType<AgentTurn<TFinal>>;
  private readonly validationSchema: z.ZodType<AgentTurn<TFinal>>;

  public constructor(
    finalSchema: z.AnyZodObject,
    tools: readonly StructuredToolSchema[] = [],
    transportFinalSchema: z.AnyZodObject = finalSchema,
  ) {
    // A discriminated union is materially simpler than a general union for LM Studio's
    // structured-output grammar.  The old union made the server explore both large
    // branches while it generated `kind`, which can leave constrained generation
    // apparently stuck before emitting a token on some models.
    this.validationSchema = this.createTurnSchema(finalSchema, tools);
    this.schema = this.createTurnSchema(transportFinalSchema, tools);
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

  public parse(value: unknown): AgentTurn<TFinal> {
    const result = this.validationSchema.safeParse(value);
    if (!result.success) {
      throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "Model response failed validation", {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
