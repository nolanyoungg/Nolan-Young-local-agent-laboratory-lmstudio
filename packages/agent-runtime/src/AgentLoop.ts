import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { ContextBudget } from "./ContextBudget.js";
import { ConversationState, type ModelMessage } from "./ConversationState.js";
import { RetryPolicy } from "./RetryPolicy.js";
import { StepLimiter } from "./StepLimiter.js";
import {
  StructuredResponseParser,
  type AgentCompleteTurn,
  type AgentTurn,
  type ModelWireTurn,
} from "./StructuredResponseParser.js";
import { ToolPermissionGuard } from "./ToolPermissionGuard.js";
import type { ToolRegistry } from "./ToolRegistry.js";
import { AgentRuntimeError } from "./errors.js";

export interface RuntimeModelRequest {
  readonly requestId: string;
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly temperature: number;
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
}

export interface RuntimeModelResponse<T> {
  readonly parsed: T;
  readonly content: string;
  readonly model?: string;
}

export interface RuntimeModelClient {
  complete<T>(
    request: RuntimeModelRequest,
    outputSchema: z.ZodType<T>,
  ): Promise<RuntimeModelResponse<T>>;
}

export interface RuntimeTrace {
  record(event: {
    type: string;
    status: string;
    runId: string;
    agentId?: string;
    step?: number;
    toolCallId?: string;
    metadata?: Readonly<Record<string, unknown>>;
  }): Promise<void>;
}

export interface AgentLoopOptions<TFinal extends Readonly<Record<string, unknown>>> {
  readonly runId: string;
  readonly agentId: string;
  readonly systemPrompt: string;
  readonly task: string;
  readonly model: string;
  readonly temperature: number;
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
  readonly maximumSteps: number;
  readonly allowedTools: readonly string[];
  readonly finalSchema: z.ZodType<TFinal>;
  readonly dryRun: boolean;
  readonly modelClient: RuntimeModelClient;
  readonly tools: ToolRegistry;
  readonly retryPolicy?: RetryPolicy;
  readonly trace?: RuntimeTrace;
  readonly shouldRetryModelError?: (error: unknown) => boolean;
}

export interface AgentLoopResult<TFinal extends Readonly<Record<string, unknown>>> {
  readonly final: AgentCompleteTurn<TFinal>;
  readonly steps: number;
  readonly toolCalls: number;
  readonly replayedToolCalls: number;
}

export class AgentLoop<TFinal extends Readonly<Record<string, unknown>>> {
  private readonly parser: StructuredResponseParser<TFinal>;
  private readonly permissions: ToolPermissionGuard;
  private readonly stepLimiter: StepLimiter;
  private readonly contextBudget: ContextBudget;
  private readonly conversation = new ConversationState();
  private readonly retryPolicy: RetryPolicy;

  public constructor(private readonly options: AgentLoopOptions<TFinal>) {
    this.parser = new StructuredResponseParser<TFinal>(
      options.finalSchema as unknown as z.AnyZodObject,
      options.tools.schemasFor(options.allowedTools),
    );
    this.permissions = new ToolPermissionGuard(options.allowedTools);
    this.stepLimiter = new StepLimiter(options.maximumSteps);
    this.contextBudget = new ContextBudget(
      options.contextTokens,
      Math.max(4_096, options.maxOutputTokens),
    );
    this.retryPolicy = options.retryPolicy ?? new RetryPolicy(0, 0);
    this.conversation.append({ role: "system", content: options.systemPrompt, critical: true });
    this.conversation.append({
      role: "system",
      critical: true,
      content:
        'MODEL OUTPUT WIRE PROTOCOL: This overrides any earlier response-shape examples. Return exactly one object matching {"kind":"tool_call"|"complete","payload":"..."}. payload must be a JSON-encoded object string. For tool_call payload use {"callId":"...","tool":"...","input":{...}}. For complete payload use the role completion fields, without kind. No prose.',
    });
    this.conversation.append({ role: "user", content: options.task, critical: true });
  }

  public async run(): Promise<AgentLoopResult<TFinal>> {
    let toolCalls = 0;
    let replayedToolCalls = 0;
    let consecutiveReplays = 0;
    let malformedResponseRepairs = 0;
    await this.options.trace?.record({
      type: "agent",
      status: "started",
      runId: this.options.runId,
      agentId: this.options.agentId,
      metadata: { model: this.options.model, dryRun: this.options.dryRun },
    });

    while (true) {
      const step = this.stepLimiter.next();
      const request: RuntimeModelRequest = {
        requestId: randomUUID(),
        model: this.options.model,
        messages: this.conversation.toModelMessages(this.contextBudget),
        temperature: this.options.temperature,
        contextTokens: this.options.contextTokens,
        maxOutputTokens: this.options.maxOutputTokens,
      };
      await this.options.trace?.record({
        type: "model_request",
        status: "started",
        runId: this.options.runId,
        agentId: this.options.agentId,
        step,
        metadata: { requestId: request.requestId, messageCount: request.messages.length },
      });

      const response = await this.retryPolicy.execute(
        () => this.options.modelClient.complete<ModelWireTurn>(request, this.parser.schema),
        this.options.shouldRetryModelError ?? (() => true),
        async ({ attempt, delayMs }) => {
          await this.options.trace?.record({
            type: "model_retry",
            status: "scheduled",
            runId: this.options.runId,
            agentId: this.options.agentId,
            step,
            metadata: { attempt, delayMs },
          });
        },
      );
      let turn: AgentTurn<TFinal>;
      try {
        turn = this.parser.parse(response.parsed);
      } catch (error) {
        if (
          error instanceof AgentRuntimeError &&
          error.code === "INVALID_MODEL_RESPONSE" &&
          malformedResponseRepairs < 2
        ) {
          malformedResponseRepairs += 1;
          const issues = Array.isArray(error.details["issues"])
            ? error.details["issues"].slice(0, 8).flatMap((issue) => {
                if (typeof issue !== "object" || issue === null || Array.isArray(issue)) return [];
                const path = (issue as Record<string, unknown>)["path"];
                return typeof path === "string" && path.length > 0 ? [path.slice(0, 128)] : [];
              })
            : [];
          await this.options.trace?.record({
            type: "model_response_repair",
            status: "scheduled",
            runId: this.options.runId,
            agentId: this.options.agentId,
            step,
            metadata: {
              attempt: malformedResponseRepairs,
              errorCode: error.code,
              issuePaths: issues,
            },
          });
          this.conversation.append({
            role: "user",
            critical: true,
            content:
              "Your previous response was rejected before any tool ran. Return a corrected MODEL OUTPUT WIRE PROTOCOL object only. payload must be a JSON-encoded object string with every required field. Do not repeat a prior callId.",
          });
          continue;
        }
        throw error;
      }
      await this.options.trace?.record({
        type: "model_request",
        status: "completed",
        runId: this.options.runId,
        agentId: this.options.agentId,
        step,
        metadata: { requestId: request.requestId, turnKind: turn.kind },
      });

      if (turn.kind === "complete") {
        await this.options.trace?.record({
          type: "agent",
          status: "completed",
          runId: this.options.runId,
          agentId: this.options.agentId,
          metadata: { steps: step, toolCalls, replayedToolCalls },
        });
        return { final: turn, steps: step, toolCalls, replayedToolCalls };
      }

      this.conversation.append({ role: "assistant", content: JSON.stringify(turn) });
      const toolResult = await this.options.tools.execute(
        turn,
        this.permissions,
        this.options.dryRun,
      );
      toolCalls += 1;
      if (toolResult.replayed) {
        replayedToolCalls += 1;
        consecutiveReplays += 1;
      } else {
        consecutiveReplays = 0;
      }
      if (consecutiveReplays > 2) {
        throw new AgentRuntimeError(
          "LOOP_DETECTED",
          "Agent repeatedly requested completed operations",
          {
            callId: turn.callId,
            tool: turn.tool,
          },
        );
      }
      await this.options.trace?.record({
        type: "tool",
        status: toolResult.status === "success" ? "completed" : "error",
        runId: this.options.runId,
        agentId: this.options.agentId,
        step,
        toolCallId: turn.callId,
        metadata: {
          tool: turn.tool,
          mutation: toolResult.mutation,
          cached: toolResult.cached,
          replayed: toolResult.replayed,
          fingerprint: toolResult.fingerprint,
          truncated: toolResult.truncated,
          beforeSha256: toolResult.beforeSha256,
          afterSha256: toolResult.afterSha256,
          ...(toolResult.status === "error" ? { error: toolResult.error } : {}),
        },
      });
      this.conversation.append({
        role: "tool",
        content: JSON.stringify(toolResult),
        critical: toolResult.status === "error",
      });
    }
  }
}
