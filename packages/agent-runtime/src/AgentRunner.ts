import type { z } from "zod";
import { AgentLoop, type AgentLoopOptions, type AgentLoopResult } from "./AgentLoop.js";

export interface AgentDefinition<TFinal extends Readonly<Record<string, unknown>>> {
  readonly id: string;
  readonly systemPrompt: string;
  readonly allowedTools: readonly string[];
  readonly finalSchema: z.ZodType<TFinal>;
  readonly transportFinalSchema?: z.ZodType<TFinal>;
}

export type AgentRunOptions<TFinal extends Readonly<Record<string, unknown>>> = Omit<
  AgentLoopOptions<TFinal>,
  "agentId" | "allowedTools" | "finalSchema" | "systemPrompt"
>;

export class AgentRunner {
  public run<TFinal extends Readonly<Record<string, unknown>>>(
    definition: AgentDefinition<TFinal>,
    options: AgentRunOptions<TFinal>,
  ): Promise<AgentLoopResult<TFinal>> {
    return new AgentLoop<TFinal>({
      ...options,
      agentId: definition.id,
      systemPrompt: definition.systemPrompt,
      allowedTools: definition.allowedTools,
      finalSchema: definition.finalSchema,
      ...(definition.transportFinalSchema === undefined
        ? {}
        : { transportFinalSchema: definition.transportFinalSchema }),
    }).run();
  }
}
