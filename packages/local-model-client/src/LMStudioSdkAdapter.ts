import { LMStudioClient } from "@lmstudio/sdk";
import type { ZodType } from "zod";

import type { ModelMessage } from "./LocalModelClient.js";
import { ModelClientError, ModelClientErrorCode, toModelClientError } from "./errors.js";

export interface SdkLoadModelInput {
  readonly sdkWebSocketUrl: string;
  readonly model: string;
  readonly contextLength: number;
  readonly signal: AbortSignal;
}

export interface SdkLoadedModel {
  readonly model: string;
  readonly handle: unknown;
}

export interface SdkCompletionInput<T> {
  readonly loadedModel: SdkLoadedModel;
  readonly messages: readonly ModelMessage[];
  readonly outputSchema: ZodType<T>;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly signal: AbortSignal;
}

export interface SdkCompletionResult {
  readonly content: string;
  readonly parsed?: unknown;
  readonly model?: string;
  readonly stopReason?: string;
}

export interface LMStudioSdkAdapter {
  initialize(sdkWebSocketUrl: string): Promise<void>;
  loadModel(input: SdkLoadModelInput): Promise<SdkLoadedModel>;
  complete<T>(input: SdkCompletionInput<T>): Promise<SdkCompletionResult>;
}

type UnknownRecord = Record<string, unknown>;

interface SdkModelLike {
  respond(messages: readonly ModelMessage[], config: Readonly<Record<string, unknown>>): unknown;
}

interface SdkClientLike {
  readonly llm: {
    model(
      key: string,
      options: {
        readonly config: { readonly contextLength: number };
        readonly signal: AbortSignal;
        readonly verbose: false;
      },
    ): Promise<SdkModelLike>;
  };
}

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function stringProperty(object: UnknownRecord | undefined, name: string): string | undefined {
  const value = object?.[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

async function predictionResult(prediction: unknown, signal: AbortSignal): Promise<UnknownRecord> {
  const predictionRecord = record(prediction);
  const cancel = predictionRecord?.["cancel"];
  const onAbort = () => {
    if (typeof cancel === "function") {
      Reflect.apply(cancel, prediction, []);
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  try {
    const initiallyAwaited = await Promise.resolve(prediction);
    const awaitedRecord = record(initiallyAwaited);
    const resultFunction = awaitedRecord?.["result"];
    const finalValue =
      typeof resultFunction === "function"
        ? await Reflect.apply(resultFunction, initiallyAwaited, [])
        : initiallyAwaited;
    const finalRecord = record(finalValue);
    if (finalRecord === undefined) {
      throw new ModelClientError(
        ModelClientErrorCode.invalidResponse,
        "The LM Studio SDK returned an unsupported prediction result.",
      );
    }
    return finalRecord;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export class DefaultLMStudioSdkAdapter implements LMStudioSdkAdapter {
  #client: SdkClientLike | undefined;
  #url: string | undefined;

  public async initialize(sdkWebSocketUrl: string): Promise<void> {
    if (this.#client !== undefined && this.#url === sdkWebSocketUrl) {
      return;
    }
    const Constructor = LMStudioClient as unknown as new (options: {
      readonly baseUrl: string;
    }) => SdkClientLike;
    this.#client = new Constructor({ baseUrl: sdkWebSocketUrl });
    this.#url = sdkWebSocketUrl;
    await Promise.resolve();
  }

  public async loadModel(input: SdkLoadModelInput): Promise<SdkLoadedModel> {
    await this.initialize(input.sdkWebSocketUrl);
    const client = this.#client;
    if (client === undefined) {
      throw new ModelClientError(
        ModelClientErrorCode.endpointUnavailable,
        "The LM Studio SDK client did not initialize.",
        { retryable: true },
      );
    }

    try {
      const model = await client.llm.model(input.model, {
        config: { contextLength: input.contextLength },
        signal: input.signal,
        verbose: false,
      });
      return { model: input.model, handle: model };
    } catch (error) {
      if (input.signal.aborted) {
        throw new ModelClientError(
          ModelClientErrorCode.cancelled,
          "LM Studio model loading was cancelled.",
          {
            cause: error,
          },
        );
      }
      throw toModelClientError(
        error,
        ModelClientErrorCode.modelLoadFailed,
        `LM Studio could not load model ${JSON.stringify(input.model)}.`,
        { retryable: true },
      );
    }
  }

  public async complete<T>(input: SdkCompletionInput<T>): Promise<SdkCompletionResult> {
    const model = input.loadedModel.handle as SdkModelLike;

    try {
      const prediction = model.respond(input.messages, {
        structured: input.outputSchema,
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        signal: input.signal,
      });
      const result = await predictionResult(prediction, input.signal);
      const modelInfo = record(result["modelInfo"]);
      const stats = record(result["stats"]);
      const content = stringProperty(result, "content") ?? "";
      const parsed = result["parsed"];
      const modelIdentifier =
        stringProperty(modelInfo, "modelKey") ??
        stringProperty(modelInfo, "identifier") ??
        stringProperty(modelInfo, "displayName");
      const stopReason = stringProperty(stats, "stopReason");
      return {
        content,
        model: modelIdentifier ?? input.loadedModel.model,
        ...(parsed === undefined ? {} : { parsed }),
        ...(stopReason === undefined ? {} : { stopReason }),
      };
    } catch (error) {
      if (input.signal.aborted) {
        throw new ModelClientError(
          ModelClientErrorCode.cancelled,
          "LM Studio prediction was cancelled.",
          {
            cause: error,
          },
        );
      }
      if (error instanceof ModelClientError) {
        throw error;
      }
      throw new ModelClientError(
        ModelClientErrorCode.endpointUnavailable,
        "LM Studio SDK prediction failed or was interrupted; partial output was discarded.",
        { retryable: true, cause: error },
      );
    }
  }
}
