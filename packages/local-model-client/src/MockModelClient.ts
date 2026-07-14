import type { ZodType } from "zod";

import type {
  AvailableModel,
  LocalModelClient,
  ModelCompletionRequest,
  ModelCompletionResponse,
  ModelHealthStatus,
  ResolvedModel,
} from "./LocalModelClient.js";
import { ModelClientError, ModelClientErrorCode } from "./errors.js";
import { LMStudioModelResolver } from "./LMStudioModelResolver.js";

export type MockCompletionStep =
  | {
      readonly kind: "response";
      readonly value: unknown;
      readonly content?: string;
      readonly model?: string;
      readonly stopReason?: string;
    }
  | {
      readonly kind: "error";
      readonly error: ModelClientError;
    };

export interface MockModelClientOptions {
  readonly responses?: readonly unknown[];
  readonly script?: readonly MockCompletionStep[];
  readonly models?: readonly AvailableModel[];
  readonly health?: ModelHealthStatus;
}

const DEFAULT_MOCK_MODEL: AvailableModel = {
  logicalKey: "mock/coder",
  variantId: "mock/coder",
  displayName: "Deterministic Mock Coder",
  type: "llm",
  loaded: true,
  contextLength: 32_768,
  capabilities: ["structured-output"],
};

export class MockModelClient implements LocalModelClient {
  readonly #script: MockCompletionStep[];
  readonly #models: readonly AvailableModel[];
  readonly #health: ModelHealthStatus;
  readonly #resolver = new LMStudioModelResolver();
  readonly #requests: ModelCompletionRequest[] = [];

  public constructor(options: MockModelClientOptions = {}) {
    this.#script = options.script
      ? [...options.script]
      : (options.responses ?? []).map((value) => ({ kind: "response" as const, value }));
    this.#models = options.models ?? [DEFAULT_MOCK_MODEL];
    this.#health =
      options.health ??
      ({
        ok: true,
        endpoint: "http://127.0.0.1:1234",
        transport: "sdk",
        durationMs: 0,
        authentication: "disabled-or-optional",
      } satisfies ModelHealthStatus);
  }

  public get remainingSteps(): number {
    return this.#script.length;
  }

  public get requests(): readonly ModelCompletionRequest[] {
    return this.#requests;
  }

  public async complete<T>(
    request: ModelCompletionRequest,
    outputSchema: ZodType<T>,
  ): Promise<ModelCompletionResponse<T>> {
    if (request.signal?.aborted === true) {
      throw new ModelClientError(
        ModelClientErrorCode.cancelled,
        "Mock model request was cancelled.",
      );
    }
    this.#requests.push(request);
    const step = this.#script.shift();
    if (step === undefined) {
      throw new ModelClientError(
        ModelClientErrorCode.mockExhausted,
        "The deterministic mock model script has no remaining response.",
      );
    }
    if (step.kind === "error") {
      throw step.error;
    }
    const parsed = outputSchema.safeParse(step.value);
    if (!parsed.success) {
      throw new ModelClientError(
        ModelClientErrorCode.malformedResponse,
        "The scripted mock response does not match the requested output schema.",
      );
    }
    return {
      value: parsed.data,
      content: step.content ?? JSON.stringify(parsed.data),
      model: step.model ?? this.#models[0]?.logicalKey ?? "mock/coder",
      transport: "mock",
      attempts: 1,
      durationMs: 0,
      ...(step.stopReason === undefined ? {} : { stopReason: step.stopReason }),
    };
  }

  public async healthCheck(): Promise<ModelHealthStatus> {
    return this.#health;
  }

  public async listModels(signal?: AbortSignal): Promise<readonly AvailableModel[]> {
    if (signal?.aborted === true) {
      throw new ModelClientError(
        ModelClientErrorCode.cancelled,
        "Mock model listing was cancelled.",
      );
    }
    return this.#models;
  }

  public async resolveModel(requestedModel: string, signal?: AbortSignal): Promise<ResolvedModel> {
    return this.#resolver.resolve(requestedModel, await this.listModels(signal));
  }
}
