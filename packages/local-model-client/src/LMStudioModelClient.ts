import type { ZodType } from "zod";

import type {
  AvailableModel,
  LMStudioConnectionConfig,
  LocalModelClient,
  ModelCompletionRequest,
  ModelCompletionResponse,
  ModelHealthStatus,
  ModelMessage,
  ResolvedModel,
} from "./LocalModelClient.js";
import { ModelCompletionRequestSchema } from "./LocalModelClient.js";
import { retryModelOperation, runWithDeadline } from "./async-control.js";
import { ModelClientError, ModelClientErrorCode } from "./errors.js";
import { LMStudioModelResolver } from "./LMStudioModelResolver.js";
import {
  LMStudioRestHealthClient,
  type FetchLike,
  type RestCompletionResult,
} from "./LMStudioRestHealthClient.js";
import {
  parseTextCompletion,
  parseStructuredCompletion,
  schemaForRest,
  type RawStructuredCompletion,
} from "./LMStudioStructuredOutput.js";

export interface LMStudioModelClientDependencies {
  readonly fetch?: FetchLike;
}

interface RawProviderResult extends RawStructuredCompletion {
  readonly model: string;
  readonly stopReason?: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
}

const INCOMPLETE_STOP_REASONS = new Set([
  "abort",
  "aborted",
  "cancelled",
  "canceled",
  "contextlengthreached",
  "error",
  "failed",
  "interrupted",
  "length",
  "maxpredictedtokensreached",
  "modelunloaded",
  "userstopped",
]);

function assertCompleteGeneration(result: RawProviderResult): void {
  const normalized = result.stopReason?.toLocaleLowerCase("en-US").replaceAll(/[^a-z]/gu, "");
  if (normalized !== undefined && INCOMPLETE_STOP_REASONS.has(normalized)) {
    throw new ModelClientError(
      ModelClientErrorCode.invalidResponse,
      "LM Studio ended the generation before a complete response; partial output was discarded.",
      { retryable: true },
    );
  }
}

const COMPLETION_REQUEST_KEYS = new Set([
  "maxTokens",
  "messages",
  "model",
  "signal",
  "structuredOutput",
  "temperature",
]);

function parseCompletionRequest(request: ModelCompletionRequest) {
  if (Object.keys(request).some((key) => !COMPLETION_REQUEST_KEYS.has(key))) {
    throw new ModelClientError(
      ModelClientErrorCode.configurationInvalid,
      "Model completion request contains unsupported fields.",
    );
  }
  const result = ModelCompletionRequestSchema.safeParse({
    messages: request.messages,
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    ...(request.structuredOutput === undefined
      ? {}
      : { structuredOutput: request.structuredOutput }),
  });
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.code}`)
      .join("; ");
    throw new ModelClientError(
      ModelClientErrorCode.configurationInvalid,
      `Model completion request is invalid (${issues}).`,
    );
  }
  return result.data;
}

export class LMStudioModelClient implements LocalModelClient {
  readonly #config: LMStudioConnectionConfig;
  readonly #rest: LMStudioRestHealthClient;
  readonly #resolver = new LMStudioModelResolver();

  public constructor(
    config: LMStudioConnectionConfig,
    dependencies: LMStudioModelClientDependencies = {},
  ) {
    this.#config = config;
    this.#rest = new LMStudioRestHealthClient(config, dependencies.fetch ?? globalThis.fetch);
  }

  public get config(): LMStudioConnectionConfig {
    return this.#config;
  }

  public get transport(): "sdk" | "rest" {
    return "rest";
  }

  public async initializeSdk(): Promise<void> {
    // The documented OpenAI-compatible HTTP API supports both local and LM Link
    // endpoints. No WebSocket connection is required by this library.
    return;
  }

  public async healthCheck(): Promise<ModelHealthStatus> {
    return this.#rest.healthCheck();
  }

  public async greetingCheck(signal?: AbortSignal): Promise<{ readonly durationMs: number }> {
    return this.#rest.greeting(signal);
  }

  public async listModels(signal?: AbortSignal): Promise<readonly AvailableModel[]> {
    const result = await runWithDeadline(
      "LM Studio model resolution",
      this.#config.resolutionTimeoutMs,
      signal,
      async (deadlineSignal) => this.#rest.listModels(deadlineSignal),
    );
    return result.models;
  }

  public async resolveModel(requestedModel: string, signal?: AbortSignal): Promise<ResolvedModel> {
    const models = await this.listModels(signal);
    return this.#resolver.resolve(requestedModel, models);
  }

  public async complete<T>(
    request: ModelCompletionRequest,
    outputSchema: ZodType<T>,
  ): Promise<ModelCompletionResponse<T>> {
    const parsedRequest = parseCompletionRequest(request);
    const requestedModel = parsedRequest.model ?? this.#config.requestedModel;
    const resolved = await this.resolveModel(requestedModel, request.signal);
    const providerModel =
      resolved.matchType === "exact-variant" ? resolved.selectedVariantId : resolved.logicalKey;
    const temperature = parsedRequest.temperature ?? this.#config.temperature;
    const maxTokens = parsedRequest.maxTokens ?? this.#config.maxTokens;
    const started = performance.now();
    const structuredOutput = parsedRequest.structuredOutput ?? true;
    const attempted = await retryModelOperation(
      this.#config.maxRetries,
      this.#config.retryDelayMs,
      request.signal,
      async () => {
        const result = await this.#rawComplete(
          providerModel,
          parsedRequest.messages,
          outputSchema,
          structuredOutput,
          temperature,
          maxTokens,
          request.signal,
        );
        assertCompleteGeneration(result);
        return result;
      },
    );
    try {
      const structured = structuredOutput
        ? parseStructuredCompletion(attempted.value, outputSchema)
        : parseTextCompletion(attempted.value, outputSchema);
      return {
        value: structured.value,
        content: structured.content,
        model: attempted.value.model,
        transport: this.transport,
        attempts: attempted.attempts,
        durationMs: Math.round(performance.now() - started),
        ...(attempted.value.stopReason === undefined
          ? {}
          : { stopReason: attempted.value.stopReason }),
        ...(attempted.value.promptTokens === undefined
          ? {}
          : { promptTokens: attempted.value.promptTokens }),
        ...(attempted.value.completionTokens === undefined
          ? {}
          : { completionTokens: attempted.value.completionTokens }),
      };
    } catch (error) {
      if (
        !(error instanceof ModelClientError) ||
        error.code !== ModelClientErrorCode.malformedResponse
      )
        throw error;
      throw new ModelClientError(
        ModelClientErrorCode.malformedResponse,
        `LM Studio returned malformed structured output (${Buffer.byteLength(attempted.value.content, "utf8")} bytes).`,
        {
          cause: error,
          details: {
            serverModel: attempted.value.model,
            malformedOutputBytes: Buffer.byteLength(attempted.value.content, "utf8"),
            ...(attempted.value.promptTokens === undefined
              ? {}
              : { promptTokens: attempted.value.promptTokens }),
            ...(attempted.value.completionTokens === undefined
              ? {}
              : { completionTokens: attempted.value.completionTokens }),
            ...(attempted.value.stopReason === undefined
              ? {}
              : { finishReason: attempted.value.stopReason }),
          },
        },
      );
    }
  }

  async #rawComplete<T>(
    model: string,
    messages: readonly ModelMessage[],
    outputSchema: ZodType<T>,
    structuredOutput: boolean,
    temperature: number,
    maxTokens: number,
    signal: AbortSignal | undefined,
  ): Promise<RawProviderResult> {
    {
      const result: RestCompletionResult = await this.#rest.complete({
        model,
        messages,
        temperature,
        maxTokens,
        ...(structuredOutput ? { jsonSchema: schemaForRest(outputSchema) } : {}),
        ...(signal === undefined ? {} : { signal }),
      });
      return result;
    }
  }
}
