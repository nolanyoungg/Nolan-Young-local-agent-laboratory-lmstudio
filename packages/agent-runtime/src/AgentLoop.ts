import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ContextBudget } from "./ContextBudget.js";
import { ConversationState, type ModelMessage } from "./ConversationState.js";
import { RetryPolicy } from "./RetryPolicy.js";
import { StepLimiter } from "./StepLimiter.js";
import {
  StructuredResponseParser,
  type AgentCompleteTurn,
  type AgentTurn,
} from "./StructuredResponseParser.js";
import { ToolPermissionGuard } from "./ToolPermissionGuard.js";
import type { ToolRegistry } from "./ToolRegistry.js";
import { AgentRuntimeError } from "./errors.js";

const MAX_MALFORMED_RESPONSE_REPAIRS = 4;
const MAX_PATCH_RECOVERY_FAILURES = 2;

function toolCallFingerprint(
  turn: AgentTurn<Readonly<Record<string, unknown>>>,
): string | undefined {
  if (turn.kind !== "tool_call") return undefined;
  return createHash("sha256")
    .update(JSON.stringify({ tool: turn.tool, input: turn.input }))
    .digest("hex");
}

function hashPreconditionNotice(tool: string, result: unknown): string | undefined {
  if (tool !== "read_file" || typeof result !== "object" || result === null) return undefined;
  const output = (result as Readonly<Record<string, unknown>>)["output"];
  if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
  const record = output as Readonly<Record<string, unknown>>;
  const path = record["path"];
  const sha256 = record["sha256"];
  if (typeof path !== "string" || typeof sha256 !== "string") return undefined;
  return `HASH PRECONDITION: The observed SHA-256 for ${JSON.stringify(path)} is ${sha256}. Any later write_file or apply_patch for this path must copy this exact value into expectedSha256. Do not guess or substitute a hash.`;
}

function toolInputPath(turn: AgentTurn<Readonly<Record<string, unknown>>>): string | undefined {
  if (turn.kind !== "tool_call" || typeof turn.input !== "object" || turn.input === null) {
    return undefined;
  }
  const path = (turn.input as Readonly<Record<string, unknown>>)["path"];
  return typeof path === "string" ? path : undefined;
}

function isMutationTool(tool: string): boolean {
  return tool === "apply_patch" || tool === "create_file" || tool === "write_file";
}

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
  readonly validateComplete?: (final: Readonly<Record<string, unknown>>) => string | undefined;
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
    const toolSchemas = options.tools.schemasFor(options.allowedTools).map((tool) => ({
      tool: tool.name,
      input: zodToJsonSchema(tool.inputSchema, { $refStrategy: "none" }),
    }));
    const finalResultSchema = zodToJsonSchema(options.finalSchema, { $refStrategy: "none" });
    this.conversation.append({ role: "system", content: options.systemPrompt, critical: true });
    this.conversation.append({
      role: "system",
      critical: true,
      content: `RESPONSE PROTOCOL: Return exactly one JSON envelope and no prose or Markdown. Every field is required: {"kind":"tool_call|complete","callId":"id-or-empty","tool":"tool-or-empty","input":"JSON string","output":"JSON string"}. Both input and output must always be valid non-empty JSON strings. For tool_call, set callId/tool and serialize the tool input in input; set output to "{}". For complete, set callId/tool to ""; set input to "{}" and serialize the final review object in output. All tool paths must be workspace-relative POSIX paths such as "theme.json" or "patterns/example.php"; never use an absolute, drive-letter, or workspace-root path. Use only these tools: ${options.allowedTools.join(", ")}. TOOL INPUT SCHEMAS: ${JSON.stringify(toolSchemas)}. FINAL RESULT JSON SCHEMA: ${JSON.stringify(finalResultSchema)}`,
    });
    this.conversation.append({ role: "user", content: options.task, critical: true });
  }

  public async run(): Promise<AgentLoopResult<TFinal>> {
    let toolCalls = 0;
    let replayedToolCalls = 0;
    let consecutiveReplays = 0;
    let patchRecoveryFailures = 0;
    let patchRecoveryPath: string | undefined;
    let malformedResponseRepairs = 0;
    const modelCallFingerprints = new Map<string, string>();
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
        () => this.options.modelClient.complete<unknown>(request, this.parser.schema),
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
        turn = this.parser.parse(response.parsed, {
          rawContent: response.content,
          harmonyCallId: `${this.options.agentId}-${step}`,
        });
      } catch (error) {
        if (
          error instanceof AgentRuntimeError &&
          error.code === "INVALID_MODEL_RESPONSE" &&
          malformedResponseRepairs < MAX_MALFORMED_RESPONSE_REPAIRS
        ) {
          malformedResponseRepairs += 1;
          const issues = Array.isArray(error.details["issues"])
            ? error.details["issues"].slice(0, 8).flatMap((issue) => {
                if (typeof issue !== "object" || issue === null || Array.isArray(issue)) return [];
                const path = (issue as Record<string, unknown>)["path"];
                return typeof path === "string" && path.length > 0 ? [path.slice(0, 128)] : [];
              })
            : [];
          const parsedRecord =
            typeof response.parsed === "object" &&
            response.parsed !== null &&
            !Array.isArray(response.parsed)
              ? (response.parsed as Readonly<Record<string, unknown>>)
              : undefined;
          const envelopeInput = parsedRecord?.["input"];
          const envelopeOutput = parsedRecord?.["output"];
          const harmonyRecipient =
            /<\|channel\|>(?:analysis|commentary)\s+to=\s*([^\s<]{1,128})/u.exec(
              response.content,
            )?.[1];
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
              issueCount: Array.isArray(error.details["issues"])
                ? error.details["issues"].length
                : 0,
              responseContentBytes: Buffer.byteLength(response.content, "utf8"),
              responseContentSha256: createHash("sha256").update(response.content).digest("hex"),
              responseParsedType: Array.isArray(response.parsed)
                ? "array"
                : response.parsed === null
                  ? "null"
                  : typeof response.parsed,
              responseParsedKeys:
                parsedRecord === undefined ? [] : Object.keys(parsedRecord).sort().slice(0, 16),
              responseParsedValueTypes:
                parsedRecord === undefined
                  ? []
                  : Object.entries(parsedRecord)
                      .sort(([left], [right]) => left.localeCompare(right))
                      .slice(0, 16)
                      .map(
                        ([key, value]) => `${key}:${Array.isArray(value) ? "array" : typeof value}`,
                      ),
              ...(typeof parsedRecord?.["kind"] === "string"
                ? { envelopeKind: parsedRecord["kind"] }
                : {}),
              ...(typeof parsedRecord?.["tool"] === "string"
                ? { envelopeTool: parsedRecord["tool"] }
                : {}),
              ...(typeof envelopeInput === "string"
                ? { envelopeInputBytes: Buffer.byteLength(envelopeInput, "utf8") }
                : {}),
              ...(typeof envelopeOutput === "string"
                ? { envelopeOutputBytes: Buffer.byteLength(envelopeOutput, "utf8") }
                : {}),
              matchingAllowedToolSchemas: this.parser.matchingToolNames(response.parsed),
              harmonyToolMarker: /<\|channel\|>(?:analysis|commentary)\s+to=/u.test(
                response.content,
              ),
              ...(harmonyRecipient === undefined ? {} : { harmonyRecipient }),
            },
          });
          this.conversation.append({
            role: "user",
            critical: true,
            content:
              "Your previous response was rejected before any tool ran. Return exactly one corrected direct JSON tool-call or completion object with every required field. Use only these tool names: " +
              `${this.options.allowedTools.join(", ")}. Do not emit Harmony control tokens, a recipient such as to=tool_call, or container.exec. Do not repeat a prior callId.`,
          });
          continue;
        }
        throw error;
      }
      if (turn.kind === "tool_call") {
        const fingerprint = toolCallFingerprint(turn);
        const existingFingerprint = modelCallFingerprints.get(turn.callId);
        if (
          fingerprint !== undefined &&
          existingFingerprint !== undefined &&
          existingFingerprint !== fingerprint
        ) {
          turn = { ...turn, callId: `${this.options.agentId}-normalized-${step}` };
        } else if (fingerprint !== undefined) {
          modelCallFingerprints.set(turn.callId, fingerprint);
        }
        // Tool registries are shared by workflow roles. Model-local call IDs such as
        // "1" must therefore be scoped before registry-level idempotency applies.
        turn = { ...turn, callId: `${this.options.agentId}:${turn.callId}` };
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
        const completionIssue = this.options.validateComplete?.(turn);
        if (completionIssue !== undefined) {
          await this.options.trace?.record({
            type: "final_result",
            status: "rejected",
            runId: this.options.runId,
            agentId: this.options.agentId,
            step,
            metadata: { reason: completionIssue.slice(0, 1_000) },
          });
          this.conversation.append({
            role: "user",
            critical: true,
            content: `Your completion was rejected: ${completionIssue} Continue with one permitted read-only tool call, then return a corrected completion.`,
          });
          continue;
        }
        await this.options.trace?.record({
          type: "agent",
          status: "completed",
          runId: this.options.runId,
          agentId: this.options.agentId,
          metadata: { steps: step, toolCalls, replayedToolCalls },
        });
        return { final: turn, steps: step, toolCalls, replayedToolCalls };
      }

      if (
        patchRecoveryPath !== undefined &&
        (turn.tool !== "read_file" || toolInputPath(turn) !== patchRecoveryPath) &&
        isMutationTool(turn.tool)
      ) {
        throw new AgentRuntimeError(
          "PATCH_RECOVERY_REQUIRED",
          "A failed patch requires a fresh read_file observation of the same path before another mutation.",
          { path: patchRecoveryPath, attemptedTool: turn.tool },
        );
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
      if (toolResult.status === "error" && toolResult.error.code === "ABSOLUTE_PATH") {
        this.conversation.append({
          role: "user",
          critical: true,
          content:
            'RECOVERY: The prior tool path was absolute and was rejected. Retry the same tool with only a workspace-relative path; for example, use "theme.json", never C:\\... or the workspace root.',
        });
      }
      const hashNotice = hashPreconditionNotice(turn.tool, toolResult);
      if (hashNotice !== undefined) {
        this.conversation.append({ role: "user", content: hashNotice, critical: true });
      }
      if (turn.tool === "apply_patch" && toolResult.status === "error") {
        patchRecoveryFailures += 1;
        patchRecoveryPath = toolInputPath(turn);
        this.conversation.append({
          role: "user",
          critical: true,
          content:
            "PATCH RECOVERY: The patch failed. Before any further mutation, call read_file for " +
            `${JSON.stringify(patchRecoveryPath ?? "the failed path")} and use its newly observed SHA-256. Prefer write_file only after that fresh read if a focused patch cannot be made valid.`,
        });
      } else if (
        patchRecoveryPath !== undefined &&
        turn.tool === "read_file" &&
        toolInputPath(turn) === patchRecoveryPath &&
        toolResult.status === "success" &&
        hashPreconditionNotice(turn.tool, toolResult) !== undefined
      ) {
        patchRecoveryPath = undefined;
      }
      if (patchRecoveryFailures >= MAX_PATCH_RECOVERY_FAILURES) {
        throw new AgentRuntimeError(
          "TOOL_EXECUTION_FAILED",
          "Agent failed a corrective patch attempt after a required fresh read; stop and inspect the observed file hash before retrying.",
          { tool: turn.tool, failures: patchRecoveryFailures },
        );
      }
    }
  }
}
