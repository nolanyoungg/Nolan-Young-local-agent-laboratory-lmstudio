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
import { validateLMStudioEndpoint } from "./LMStudioEndpoint.js";
import { LMStudioModelResolver } from "./LMStudioModelResolver.js";
import {
  LMStudioRestHealthClient,
  type FetchLike,
  type RestCompletionResult,
} from "./LMStudioRestHealthClient.js";
import {
  appendStructuredRepairInstruction,
  parseStructuredCompletion,
  schemaForRest,
  type RawStructuredCompletion,
} from "./LMStudioStructuredOutput.js";
import {
  DefaultLMStudioSdkAdapter,
  type LMStudioSdkAdapter,
  type SdkCompletionResult,
} from "./LMStudioSdkAdapter.js";

export interface LMStudioModelClientDependencies {
  readonly fetch?: FetchLike;
  readonly sdk?: LMStudioSdkAdapter;
}

interface RawProviderResult extends RawStructuredCompletion {
  readonly model: string;
  readonly stopReason?: string;
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
      "LM Studio ended the generation before a complete structured response; partial output was discarded.",
      { retryable: true },
    );
  }
}

const COMPLETION_REQUEST_KEYS = new Set([
  "maxTokens",
  "messages",
  "model",
  "signal",
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
  readonly #endpoint: ReturnType<typeof validateLMStudioEndpoint>;
  readonly #rest: LMStudioRestHealthClient;
  readonly #sdk: LMStudioSdkAdapter;
  readonly #resolver = new LMStudioModelResolver();

  public constructor(
    config: LMStudioConnectionConfig,
    dependencies: LMStudioModelClientDependencies = {},
  ) {
    this.#config = config;
    this.#endpoint = validateLMStudioEndpoint(config.baseUrl);
    this.#rest = new LMStudioRestHealthClient(config, dependencies.fetch ?? globalThis.fetch);
    this.#sdk = dependencies.sdk ?? new DefaultLMStudioSdkAdapter();
  }

  public get config(): LMStudioConnectionConfig {
    return this.#config;
  }

  public get transport(): "sdk" | "rest" {
    return this.#config.apiToken === undefined ? "sdk" : "rest";
  }

  public async initializeSdk(): Promise<void> {
    if (this.#config.apiToken !== undefined) {
      return;
    }
    await runWithDeadline(
      "LM Studio SDK initialization",
      this.#config.connectionTimeoutMs,
      undefined,
      async () => this.#sdk.initialize(this.#endpoint.sdkWebSocketUrl),
    );
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
    let messages = parsedRequest.messages;
    let totalAttempts = 0;

    for (let repairAttempt = 0; repairAttempt <= this.#config.maxRetries; repairAttempt += 1) {
      const attempted = await retryModelOperation(
        this.#config.maxRetries,
        this.#config.retryDelayMs,
        request.signal,
        async () => {
          const result = await this.#rawComplete(
            providerModel,
            messages,
            outputSchema,
            temperature,
            maxTokens,
            request.signal,
          );
          assertCompleteGeneration(result);
          return result;
        },
      );
      totalAttempts += attempted.attempts;
      try {
        const structured = parseStructuredCompletion(attempted.value, outputSchema);
        return {
          value: structured.value,
          content: structured.content,
          model: attempted.value.model,
          transport: this.transport,
          attempts: totalAttempts,
          durationMs: Math.round(performance.now() - started),
          ...(attempted.value.stopReason === undefined
            ? {}
            : { stopReason: attempted.value.stopReason }),
        };
      } catch (error) {
        if (
          !(error instanceof ModelClientError) ||
          error.code !== ModelClientErrorCode.malformedResponse ||
          repairAttempt >= this.#config.maxRetries
        ) {
          throw error;
        }
        messages = [...appendStructuredRepairInstruction(parsedRequest.messages, error)];
      }
    }

    throw new ModelClientError(
      ModelClientErrorCode.malformedResponse,
      "LM Studio exhausted structured-output repair attempts.",
    );
  }

  async #rawComplete<T>(
    model: string,
    messages: readonly ModelMessage[],
    outputSchema: ZodType<T>,
    temperature: number,
    maxTokens: number,
    signal: AbortSignal | undefined,
  ): Promise<RawProviderResult> {
    if (this.#config.apiToken !== undefined) {
      await runWithDeadline(
        "LM Studio model loading",
        this.#config.loadTimeoutMs,
        signal,
        async (deadlineSignal) =>
          this.#rest.loadModel(model, this.#config.contextLength, deadlineSignal),
      );
      const result: RestCompletionResult = await this.#rest.complete({
        model,
        messages,
        temperature,
        maxTokens,
        jsonSchema: schemaForRest(outputSchema),
        ...(signal === undefined ? {} : { signal }),
      });
      return result;
    }

    const loadedModel = await runWithDeadline(
      "LM Studio model loading",
      this.#config.loadTimeoutMs,
      signal,
      async (deadlineSignal) =>
        this.#sdk.loadModel({
          sdkWebSocketUrl: this.#endpoint.sdkWebSocketUrl,
          model,
          contextLength: this.#config.contextLength,
          signal: deadlineSignal,
        }),
    );
    const result: SdkCompletionResult = await runWithDeadline(
      "LM Studio prediction",
      this.#config.predictionTimeoutMs,
      signal,
      async (deadlineSignal) =>
        this.#sdk.complete({
          loadedModel,
          messages,
          outputSchema,
          temperature,
          maxTokens,
          signal: deadlineSignal,
        }),
    );
    return {
      content: result.content,
      model: result.model ?? model,
      ...(result.parsed === undefined ? {} : { parsed: result.parsed }),
      ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
    };
  }
}
