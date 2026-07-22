import type {
  AvailableModel,
  LMStudioConnectionConfig,
  ModelHealthStatus,
  ModelMessage,
} from "./LocalModelClient.js";
import { AvailableModelSchema } from "./LocalModelClient.js";
import { runWithDeadline } from "./async-control.js";
import { ModelClientError, ModelClientErrorCode, toModelClientError } from "./errors.js";
import { lmStudioEndpointUrl, lmStudioNativeEndpointUrl } from "./LMStudioEndpoint.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const MAX_LM_STUDIO_REST_RESPONSE_BYTES = 4 * 1_024 * 1_024;

export interface RestModelListResult {
  readonly models: readonly AvailableModel[];
  readonly apiVersion?: string;
  readonly durationMs: number;
}

export interface RestGreetingResult {
  readonly durationMs: number;
}

export interface RestCompletionInput {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly temperature: number;
  readonly maxTokens: number;
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export interface RestCompletionResult {
  readonly content: string;
  readonly model: string;
  readonly stopReason?: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
}

type UnknownRecord = Record<string, unknown>;

function discardResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function firstString(
  object: UnknownRecord | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function firstNumber(
  object: UnknownRecord | undefined,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return undefined;
}

function firstBoolean(
  object: UnknownRecord | undefined,
  keys: readonly string[],
): boolean | undefined {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function capabilities(object: UnknownRecord): string[] {
  const value = object["capabilities"];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  const capabilityRecord = record(value);
  return capabilityRecord === undefined
    ? []
    : Object.entries(capabilityRecord)
        .filter(([, enabled]) => enabled === true)
        .map(([name]) => name);
}

function optionalProperties(model: UnknownRecord, instance: UnknownRecord | undefined) {
  const loaded =
    firstBoolean(instance, ["loaded", "is_loaded"]) ??
    firstBoolean(model, ["loaded", "is_loaded"]) ??
    (instance === undefined ? undefined : true);
  const contextLength =
    firstNumber(instance, ["context_length", "contextLength", "max_context_length"]) ??
    firstNumber(record(instance?.["config"]), ["context_length", "contextLength"]) ??
    firstNumber(model, ["context_length", "contextLength", "max_context_length"]);
  const format =
    firstString(instance, ["format", "compatibility_type", "architecture"]) ??
    firstString(record(instance?.["quantization"]), ["name"]) ??
    firstString(model, ["format", "compatibility_type", "architecture"]) ??
    firstString(record(model["quantization"]), ["name"]);
  const source =
    firstString(instance, ["source", "provider", "origin"]) ??
    firstString(model, ["source", "provider", "origin"]);
  const device =
    firstString(instance, ["device", "device_name", "deviceName"]) ??
    firstString(model, ["device", "device_name", "deviceName"]);
  return {
    ...(loaded === undefined ? {} : { loaded }),
    ...(contextLength === undefined ? {} : { contextLength }),
    ...(format === undefined ? {} : { format }),
    ...(source === undefined ? {} : { source }),
    ...(device === undefined ? {} : { device }),
  };
}

function normalizeModel(modelValue: unknown): AvailableModel[] {
  const model = record(modelValue);
  if (model === undefined) {
    return [];
  }
  const logicalKey = firstString(model, ["key", "model_key", "modelKey", "id", "identifier"]);
  if (logicalKey === undefined) {
    return [];
  }
  const displayName = firstString(model, ["display_name", "displayName", "name"]) ?? logicalKey;
  const type = firstString(model, ["type", "model_type", "modelType"]) ?? "llm";
  const modelCapabilities = capabilities(model);
  const instancesValue =
    model["loaded_instances"] ?? model["loadedInstances"] ?? model["instances"];
  const instances = Array.isArray(instancesValue)
    ? instancesValue.map(record).filter((value) => value !== undefined)
    : [];
  if (instances.length === 0) {
    const variantId =
      firstString(model, ["variant_id", "variantId", "selected_instance_id", "id"]) ?? logicalKey;
    const parsed = AvailableModelSchema.safeParse({
      logicalKey,
      variantId,
      displayName,
      type,
      capabilities: modelCapabilities,
      ...(Array.isArray(instancesValue) ? { loaded: false } : {}),
      ...optionalProperties(model, undefined),
    });
    return parsed.success ? [parsed.data] : [];
  }
  return instances.flatMap((instance, index) => {
    const parsed = AvailableModelSchema.safeParse({
      logicalKey,
      variantId:
        firstString(instance, ["id", "identifier", "instance_id", "instanceId"]) ??
        `${logicalKey}#${index + 1}`,
      displayName,
      type,
      capabilities: modelCapabilities,
      ...optionalProperties(model, instance),
    });
    return parsed.success ? [parsed.data] : [];
  });
}

function extractApiVersion(response: Response, payload?: unknown): string | undefined {
  const payloadRecord = record(payload);
  return (
    response.headers.get("x-lm-studio-version") ??
    response.headers.get("lm-studio-version") ??
    firstString(payloadRecord, ["api_version", "apiVersion", "version"])
  );
}

function assertSupportedVersion(apiVersion: string | undefined): void {
  if (apiVersion === undefined) {
    return;
  }
  const match = /(?:^|\D)(\d+)\.(\d+)(?:\.\d+)?/u.exec(apiVersion);
  if (match === null) {
    return;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 0 && minor < 4) {
    throw new ModelClientError(
      ModelClientErrorCode.incompatibleVersion,
      `LM Studio ${apiVersion} is too old for the native v1 REST API; version 0.4.0 or newer is required.`,
    );
  }
}

export class LMStudioRestHealthClient {
  readonly #config: LMStudioConnectionConfig;
  readonly #fetch: FetchLike;

  public constructor(
    config: LMStudioConnectionConfig,
    fetchImplementation: FetchLike = globalThis.fetch,
  ) {
    this.#config = config;
    this.#fetch = fetchImplementation;
  }

  public async healthCheck(signal?: AbortSignal): Promise<ModelHealthStatus> {
    const started = performance.now();
    try {
      const result = await this.listModels(signal);
      return {
        ok: true,
        endpoint: this.#config.baseUrl,
        transport: "rest",
        durationMs: Math.round(performance.now() - started),
        authentication:
          this.#config.apiToken === undefined ? "disabled-or-optional" : "token-accepted",
        ...(result.apiVersion === undefined ? {} : { apiVersion: result.apiVersion }),
      };
    } catch (error) {
      const modelError = toModelClientError(
        error,
        ModelClientErrorCode.endpointUnavailable,
        "LM Studio did not respond through the local endpoint.",
        { retryable: true, secrets: this.#secrets() },
      );
      const authentication =
        modelError.code === ModelClientErrorCode.authenticationRequired
          ? "required"
          : modelError.code === ModelClientErrorCode.invalidToken
            ? "rejected"
            : "unknown";
      return {
        ok: false,
        endpoint: this.#config.baseUrl,
        transport: "rest",
        durationMs: Math.round(performance.now() - started),
        authentication,
        error: modelError.toStructuredError(),
      };
    }
  }

  public async greeting(signal?: AbortSignal): Promise<RestGreetingResult> {
    const started = performance.now();
    await this.#request("/", { method: "GET" }, signal, "LM Studio greeting", async (response) =>
      response.body?.cancel().catch(() => undefined),
    );
    return { durationMs: Math.round(performance.now() - started) };
  }

  public async listModels(signal?: AbortSignal): Promise<RestModelListResult> {
    const started = performance.now();
    const { response, payload } = await this.#request(
      "/api/v1/models",
      { method: "GET" },
      signal,
      "LM Studio native model listing",
      async (response, deadlineSignal) => ({
        response,
        payload: await this.#json(response, deadlineSignal),
      }),
    );
    const apiVersion = extractApiVersion(response, payload);
    assertSupportedVersion(apiVersion);
    const payloadRecord = record(payload);
    const entries = Array.isArray(payload)
      ? payload
      : Array.isArray(payloadRecord?.["models"])
        ? payloadRecord["models"]
        : Array.isArray(payloadRecord?.["data"])
          ? payloadRecord["data"]
          : undefined;
    if (entries === undefined) {
      throw new ModelClientError(
        ModelClientErrorCode.invalidResponse,
        "LM Studio /api/v1/models returned an unsupported response shape.",
      );
    }
    const models = entries.flatMap(normalizeModel);
    return {
      models,
      durationMs: Math.round(performance.now() - started),
      ...(apiVersion === undefined ? {} : { apiVersion }),
    };
  }

  public async complete(input: RestCompletionInput): Promise<RestCompletionResult> {
    const { payload } = await this.#request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          temperature: input.temperature,
          max_tokens: input.maxTokens,
          stream: false,
          ...(input.jsonSchema === undefined
            ? {}
            : {
                response_format: {
                  type: "json_schema",
                  json_schema: {
                    name: "local_agent_response",
                    strict: true,
                    schema: input.jsonSchema,
                  },
                },
              }),
        }),
      },
      input.signal,
      "LM Studio prediction",
      async (response, deadlineSignal) => ({
        payload: await this.#json(response, deadlineSignal),
      }),
      this.#config.predictionTimeoutMs,
    );
    const payloadRecord = record(payload);
    const choices = payloadRecord?.["choices"];
    const firstChoice = Array.isArray(choices) ? record(choices[0]) : undefined;
    const message = record(firstChoice?.["message"]);
    const content = firstString(message, ["content"]);
    if (content === undefined) {
      throw new ModelClientError(
        ModelClientErrorCode.emptyResponse,
        "LM Studio returned an empty completion.",
        { retryable: true },
      );
    }
    const responseModel = firstString(payloadRecord, ["model"]) ?? input.model;
    const stopReason = firstString(firstChoice, ["finish_reason", "finishReason"]);
    const usage = record(payloadRecord?.["usage"]);
    const promptTokens = firstNumber(usage, ["prompt_tokens", "promptTokens", "input_tokens"]);
    const completionTokens = firstNumber(usage, [
      "completion_tokens",
      "completionTokens",
      "output_tokens",
    ]);
    return {
      content,
      model: responseModel,
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
    };
  }

  async #request<T>(
    path: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    operationName: string,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
    timeoutMs = this.#config.connectionTimeoutMs,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.#config.apiToken !== undefined) {
      headers.set("authorization", `Bearer ${this.#config.apiToken}`);
    }
    return runWithDeadline(operationName, timeoutMs, signal, async (deadlineSignal) => {
      let response: Response;
      try {
        const url = path.startsWith("/api/")
          ? lmStudioNativeEndpointUrl(this.#config.baseUrl, path)
          : lmStudioEndpointUrl(this.#config.baseUrl, path);
        response = await this.#fetch(url, {
          ...init,
          headers,
          signal: deadlineSignal,
        });
      } catch (error) {
        throw toModelClientError(
          error,
          ModelClientErrorCode.endpointUnavailable,
          `${operationName} failed through the local LM Studio endpoint.`,
          { retryable: true, secrets: this.#secrets() },
        );
      }

      if (response.status === 401 || response.status === 403) {
        discardResponseBody(response);
        throw new ModelClientError(
          this.#config.apiToken === undefined
            ? ModelClientErrorCode.authenticationRequired
            : ModelClientErrorCode.invalidToken,
          this.#config.apiToken === undefined
            ? "LM Studio requires an API token. Set LM_STUDIO_API_TOKEN in the laboratory environment."
            : "LM Studio rejected the configured API token.",
        );
      }
      if (!response.ok) {
        const detail = await this.#errorDetail(response);
        const retryable =
          response.status === 408 ||
          response.status === 409 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
        throw new ModelClientError(
          path.endsWith("/load")
            ? ModelClientErrorCode.modelLoadFailed
            : ModelClientErrorCode.invalidResponse,
          `${operationName} failed with HTTP ${response.status}${detail === undefined ? "." : `: ${detail}`}`,
          { retryable },
        );
      }
      return consume(response, deadlineSignal);
    });
  }

  async #json(response: Response, signal: AbortSignal): Promise<unknown> {
    const contentLength = response.headers.get("content-length");
    if (
      /^\d+$/u.test(contentLength ?? "") &&
      Number(contentLength) > MAX_LM_STUDIO_REST_RESPONSE_BYTES
    ) {
      discardResponseBody(response);
      throw new ModelClientError(
        ModelClientErrorCode.invalidResponse,
        `LM Studio response exceeded the ${MAX_LM_STUDIO_REST_RESPONSE_BYTES}-byte limit.`,
      );
    }

    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const onAbort = () => {
      void reader?.cancel(signal.reason).catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      if (reader !== undefined) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_LM_STUDIO_REST_RESPONSE_BYTES) {
            void reader.cancel().catch(() => undefined);
            throw new ModelClientError(
              ModelClientErrorCode.invalidResponse,
              `LM Studio response exceeded the ${MAX_LM_STUDIO_REST_RESPONSE_BYTES}-byte limit.`,
            );
          }
          chunks.push(value);
        }
      }

      const bytes = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof ModelClientError) {
        throw error;
      }
      throw new ModelClientError(
        ModelClientErrorCode.invalidResponse,
        "LM Studio returned malformed JSON.",
        { cause: error },
      );
    } finally {
      signal.removeEventListener("abort", onAbort);
      reader?.releaseLock();
    }
  }

  async #errorDetail(response: Response): Promise<string | undefined> {
    try {
      const raw = await response.text();
      const text =
        this.#config.apiToken === undefined
          ? raw
          : raw.replaceAll(this.#config.apiToken, "[REDACTED]");
      const compact = text.replaceAll(/[\r\n\t]+/gu, " ").trim();
      return compact.length === 0 ? undefined : compact.slice(0, 512);
    } catch {
      return undefined;
    }
  }

  #secrets(): readonly string[] {
    return this.#config.apiToken === undefined ? [] : [this.#config.apiToken];
  }
}
