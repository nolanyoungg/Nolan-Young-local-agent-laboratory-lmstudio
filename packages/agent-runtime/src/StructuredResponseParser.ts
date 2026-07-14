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

/**
 * Deliberately small model-facing envelope.  Some local constrained decoders
 * struggle to compile the full protocol union (one branch per authorized
 * tool).  The JSON payload is decoded and validated against the full strict
 * protocol before it is allowed to reach the tool registry.
 */
export const ModelWireTurnSchema = z
  .object({
    kind: z.enum(["tool_call", "complete"]),
    // Keep the server grammar as simple as possible. The decoded protocol is
    // bounded separately by its strict local schemas and the model max tokens.
    payload: z.string(),
  })
  .strict();

export type ModelWireTurn = z.infer<typeof ModelWireTurnSchema>;

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
  public readonly schema: z.ZodType<ModelWireTurn> = ModelWireTurnSchema;
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

  public parse(value: unknown): AgentTurn<TFinal> {
    // Preserve direct validation for internal callers and backwards-compatible
    // deterministic test scripts. Live model responses use the wire envelope.
    const direct = this.validationSchema.safeParse(value);
    if (direct.success) return direct.data;

    const wire = this.schema.safeParse(value);
    if (!wire.success) {
      return this.invalid(wire.error.issues);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(wire.data.payload) as unknown;
    } catch {
      throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "Model wire payload was not JSON", {
        issues: [{ path: "payload", message: "Expected a JSON object encoded as a string." }],
      });
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new AgentRuntimeError(
        "INVALID_MODEL_RESPONSE",
        "Model wire payload was not an object",
        {
          issues: [{ path: "payload", message: "Expected a JSON object encoded as a string." }],
        },
      );
    }
    const result = this.validationSchema.safeParse({ kind: wire.data.kind, ...payload });
    if (!result.success) {
      return this.invalid(result.error.issues);
    }
    return result.data;
  }

  private invalid(issues: readonly z.ZodIssue[]): never {
    throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "Model response failed validation", {
      issues: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
}
