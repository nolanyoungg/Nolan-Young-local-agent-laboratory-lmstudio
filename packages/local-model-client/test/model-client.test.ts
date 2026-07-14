import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import {
  LMStudioModelClient,
  ModelClientError,
  ModelClientErrorCode,
  createLMStudioConnectionConfig,
  type FetchLike,
  type LMStudioSdkAdapter,
  type ModelCompletionRequest,
  type SdkCompletionInput,
  type SdkCompletionResult,
  type SdkLoadModelInput,
  type SdkLoadedModel,
} from "../src/index.js";

const outputSchema = z.object({ answer: z.string().min(1) }).strict();

function modelsFetch(): FetchLike {
  return async () =>
    new Response(
      JSON.stringify({
        models: [{ key: "qwen/qwen2.5-coder-14b", display_name: "Qwen Coder", type: "llm" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

class ScriptedSdk implements LMStudioSdkAdapter {
  readonly calls: SdkCompletionInput<unknown>[] = [];
  readonly loads: SdkLoadModelInput[] = [];
  initializedUrl: string | undefined;

  public constructor(private readonly script: Array<SdkCompletionResult | Error | "never">) {}

  public async initialize(url: string): Promise<void> {
    this.initializedUrl = url;
  }

  public async loadModel(input: SdkLoadModelInput): Promise<SdkLoadedModel> {
    this.loads.push(input);
    await this.initialize(input.sdkWebSocketUrl);
    return { model: input.model, handle: {} };
  }

  public async complete<T>(input: SdkCompletionInput<T>): Promise<SdkCompletionResult> {
    this.calls.push(input as SdkCompletionInput<unknown>);
    const step = this.script.shift();
    if (step === "never") return new Promise(() => undefined);
    if (step instanceof Error) throw step;
    if (step === undefined) throw new Error("script exhausted");
    return step;
  }
}

describe("LMStudioModelClient SDK transport", () => {
  it("derives the SDK WebSocket URL and independently validates structured output", async () => {
    const sdk = new ScriptedSdk([{ content: '{"answer":"ok"}', parsed: { answer: "ok" } }]);
    const client = new LMStudioModelClient(createLMStudioConnectionConfig({ maxRetries: 0 }), {
      fetch: modelsFetch(),
      sdk,
    });
    const result = await client.complete(
      { messages: [{ role: "user", content: "answer" }] },
      outputSchema,
    );
    expect(result.value).toEqual({ answer: "ok" });
    expect(result.transport).toBe("sdk");
    expect(sdk.initializedUrl).toBe("ws://127.0.0.1:1234");
    expect(sdk.calls[0]).toMatchObject({ maxTokens: 4_096 });
    expect(sdk.calls[0]?.structuredOutput).toBe(true);
  });

  it("allows agent turns to opt out of SDK constrained decoding while preserving local validation", async () => {
    const sdk = new ScriptedSdk([{ content: '{"answer":"plain-json"}' }]);
    const client = new LMStudioModelClient(createLMStudioConnectionConfig({ maxRetries: 0 }), {
      fetch: modelsFetch(),
      sdk,
    });

    const result = await client.complete(
      { messages: [{ role: "user", content: "answer" }], structuredOutput: false },
      outputSchema,
    );

    expect(result.value).toEqual({ answer: "plain-json" });
    expect(sdk.calls[0]?.structuredOutput).toBe(false);
  });

  it("extracts the final JSON value from reasoning-model prose before validation", async () => {
    const sdk = new ScriptedSdk([
      { content: 'I will answer with JSON.\n```json\n{"answer":"extracted"}\n```' },
    ]);
    const client = new LMStudioModelClient(createLMStudioConnectionConfig({ maxRetries: 0 }), {
      fetch: modelsFetch(),
      sdk,
    });

    await expect(
      client.complete(
        { messages: [{ role: "user", content: "answer" }], structuredOutput: false },
        outputSchema,
      ),
    ).resolves.toMatchObject({ value: { answer: "extracted" } });
  });

  it("uses an exact selected variant ID for SDK loading and inference", async () => {
    const sdk = new ScriptedSdk([{ content: '{"answer":"mac"}', parsed: { answer: "mac" } }]);
    const fetchMock: FetchLike = async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              key: "qwen/coder",
              loaded_instances: [
                { id: "windows-instance", device: "Windows" },
                { id: "mac-instance", device: "Mac" },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    const client = new LMStudioModelClient(createLMStudioConnectionConfig({ maxRetries: 0 }), {
      fetch: fetchMock,
      sdk,
    });

    await client.complete(
      { messages: [{ role: "user", content: "answer" }], model: "mac-instance" },
      outputSchema,
    );

    expect(sdk.loads[0]?.model).toBe("mac-instance");
    expect(sdk.calls[0]?.loadedModel.model).toBe("mac-instance");
  });

  it("uses the logical key for preferred-device routing unless a variant was explicit", async () => {
    const sdk = new ScriptedSdk([{ content: '{"answer":"routed"}', parsed: { answer: "routed" } }]);
    const fetchMock: FetchLike = async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              key: "qwen/coder",
              loaded_instances: [
                { id: "windows-instance", device: "Windows", loaded: true },
                { id: "mac-instance", device: "Mac" },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    const client = new LMStudioModelClient(createLMStudioConnectionConfig({ maxRetries: 0 }), {
      fetch: fetchMock,
      sdk,
    });

    await client.complete(
      { messages: [{ role: "user", content: "answer" }], model: "qwen/coder" },
      outputSchema,
    );

    expect(sdk.loads[0]?.model).toBe("qwen/coder");
    expect(sdk.calls[0]?.loadedModel.model).toBe("qwen/coder");
  });

  it("performs bounded schema repair without copying malformed content into the prompt", async () => {
    const sdk = new ScriptedSdk([
      { content: "TOP-SECRET malformed material" },
      { content: '{"answer":"repaired"}', parsed: { answer: "repaired" } },
    ]);
    const client = new LMStudioModelClient(
      createLMStudioConnectionConfig({ maxRetries: 1, retryDelayMs: 0 }),
      { fetch: modelsFetch(), sdk },
    );
    const result = await client.complete(
      { messages: [{ role: "user", content: "answer" }] },
      outputSchema,
    );
    expect(result.value.answer).toBe("repaired");
    expect(sdk.calls).toHaveLength(2);
    expect(JSON.stringify(sdk.calls[1]?.messages)).not.toContain("TOP-SECRET");
    expect(JSON.stringify(sdk.calls[1]?.messages)).toContain("Validation issues");
  });

  it("rejects empty and malformed final responses", async () => {
    const empty = new LMStudioModelClient(createLMStudioConnectionConfig({ maxRetries: 0 }), {
      fetch: modelsFetch(),
      sdk: new ScriptedSdk([{ content: "" }]),
    });
    await expect(
      empty.complete({ messages: [{ role: "user", content: "answer" }] }, outputSchema),
    ).rejects.toMatchObject({ code: ModelClientErrorCode.emptyResponse });

    const malformed = new LMStudioModelClient(createLMStudioConnectionConfig({ maxRetries: 0 }), {
      fetch: modelsFetch(),
      sdk: new ScriptedSdk([{ content: "not-json" }]),
    });
    await expect(
      malformed.complete({ messages: [{ role: "user", content: "answer" }] }, outputSchema),
    ).rejects.toMatchObject({ code: ModelClientErrorCode.malformedResponse });
  });

  it("retries token-limit truncation and discards interrupted structured output", async () => {
    const retryingSdk = new ScriptedSdk([
      {
        content: '{"answer":"partial-but-valid"}',
        parsed: { answer: "partial-but-valid" },
        stopReason: "maxPredictedTokensReached",
      },
      { content: '{"answer":"complete"}', parsed: { answer: "complete" }, stopReason: "eosFound" },
    ]);
    const retryingClient = new LMStudioModelClient(
      createLMStudioConnectionConfig({ maxRetries: 1, retryDelayMs: 0 }),
      { fetch: modelsFetch(), sdk: retryingSdk },
    );

    await expect(
      retryingClient.complete({ messages: [{ role: "user", content: "answer" }] }, outputSchema),
    ).resolves.toMatchObject({ value: { answer: "complete" }, attempts: 2 });

    const interruptedClient = new LMStudioModelClient(
      createLMStudioConnectionConfig({ maxRetries: 0 }),
      {
        fetch: modelsFetch(),
        sdk: new ScriptedSdk([
          {
            content: '{"answer":"must-not-be-accepted"}',
            parsed: { answer: "must-not-be-accepted" },
            stopReason: "userStopped",
          },
        ]),
      },
    );
    await expect(
      interruptedClient.complete({ messages: [{ role: "user", content: "answer" }] }, outputSchema),
    ).rejects.toMatchObject({ code: ModelClientErrorCode.invalidResponse });
  });

  it("aborts a prediction deadline even when an adapter ignores its signal", async () => {
    vi.useFakeTimers();
    try {
      const client = new LMStudioModelClient(
        createLMStudioConnectionConfig({ maxRetries: 0, predictionTimeoutMs: 1_000 }),
        { fetch: modelsFetch(), sdk: new ScriptedSdk(["never"]) },
      );
      const completion = client.complete(
        { messages: [{ role: "user", content: "answer" }] },
        outputSchema,
      );
      const observedCompletion = completion.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(observedCompletion).resolves.toMatchObject({
        code: ModelClientErrorCode.timeout,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates caller cancellation and discards an interrupted prediction", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const sdk: LMStudioSdkAdapter = {
      initialize: async () => undefined,
      loadModel: async (input) => ({ model: input.model, handle: {} }),
      complete: async (input) => {
        markStarted?.();
        return new Promise((_resolve, reject) => {
          input.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    };
    const controller = new AbortController();
    const client = new LMStudioModelClient(createLMStudioConnectionConfig({ maxRetries: 0 }), {
      fetch: modelsFetch(),
      sdk,
    });
    const completion = client.complete(
      {
        messages: [{ role: "user", content: "answer" }],
        signal: controller.signal,
      },
      outputSchema,
    );
    await started;
    controller.abort();
    await expect(completion).rejects.toMatchObject({ code: ModelClientErrorCode.cancelled });
  });

  it("bounds retryable model operations and rejects extra request fields", async () => {
    const sdk = new ScriptedSdk([
      new ModelClientError(ModelClientErrorCode.endpointUnavailable, "temporary", {
        retryable: true,
      }),
      new ModelClientError(ModelClientErrorCode.endpointUnavailable, "temporary", {
        retryable: true,
      }),
      { content: '{"answer":"too-late"}', parsed: { answer: "too-late" } },
    ]);
    const client = new LMStudioModelClient(
      createLMStudioConnectionConfig({ maxRetries: 1, retryDelayMs: 0 }),
      { fetch: modelsFetch(), sdk },
    );
    await expect(
      client.complete({ messages: [{ role: "user", content: "answer" }] }, outputSchema),
    ).rejects.toMatchObject({ code: ModelClientErrorCode.endpointUnavailable });
    expect(sdk.calls).toHaveLength(2);

    const invalidRequest = {
      messages: [{ role: "user", content: "answer" }],
      executable: "not-allowed",
    } as unknown as ModelCompletionRequest;
    await expect(client.complete(invalidRequest, outputSchema)).rejects.toMatchObject({
      code: ModelClientErrorCode.configurationInvalid,
    });
  });
});

describe("LMStudioModelClient authenticated REST transport", () => {
  it("loads and completes with Bearer auth and JSON Schema without initializing SDK", async () => {
    const token = "local-api-token";
    const sdk: LMStudioSdkAdapter = {
      initialize: vi.fn(async () => undefined),
      loadModel: vi.fn(async (input) => ({ model: input.model, handle: {} })),
      complete: vi.fn(async () => ({ content: "unexpected" })),
    };
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetchMock: FetchLike = async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, ...(init === undefined ? {} : { init }) });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      if (path === "/api/v1/models") {
        return new Response(
          JSON.stringify({
            models: [
              {
                key: "qwen/qwen2.5-coder-14b",
                loaded_instances: [{ id: "windows-instance" }, { id: "mac-instance" }],
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (path === "/api/v1/models/load") {
        expect(JSON.parse(String(init?.body))).toMatchObject({ model: "mac-instance" });
        return new Response(JSON.stringify({ status: "loaded" }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body["model"]).toBe("mac-instance");
      expect(body["response_format"]).toMatchObject({ type: "json_schema" });
      return new Response(
        JSON.stringify({
          model: "qwen/qwen2.5-coder-14b",
          choices: [{ message: { content: '{"answer":"rest"}' }, finish_reason: "stop" }],
        }),
        { status: 200 },
      );
    };
    const client = new LMStudioModelClient(
      createLMStudioConnectionConfig({ apiToken: token, maxRetries: 0 }),
      { fetch: fetchMock, sdk },
    );
    const result = await client.complete(
      { messages: [{ role: "user", content: "answer" }], model: "mac-instance" },
      outputSchema,
    );
    expect(result.transport).toBe("rest");
    expect(result.value.answer).toBe("rest");
    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/models",
      "/api/v1/models/load",
      "/v1/chat/completions",
    ]);
    expect(sdk.initialize).not.toHaveBeenCalled();
  });

  it("selects SDK only for an absent token and rejects unsafe token syntax", () => {
    const sdkClient = new LMStudioModelClient(createLMStudioConnectionConfig({ apiToken: "   " }), {
      fetch: modelsFetch(),
      sdk: new ScriptedSdk([]),
    });
    const restClient = new LMStudioModelClient(
      createLMStudioConnectionConfig({ apiToken: "valid-local-token" }),
      { fetch: modelsFetch(), sdk: new ScriptedSdk([]) },
    );
    expect(sdkClient.transport).toBe("sdk");
    expect(restClient.transport).toBe("rest");
    expect(() => createLMStudioConnectionConfig({ apiToken: "invalid token" })).toThrowError(
      expect.objectContaining({ code: ModelClientErrorCode.configurationInvalid }),
    );
  });

  it("prefers MODEL_REQUEST_TIMEOUT_MS over the legacy prediction timeout alias", () => {
    expect(
      createLMStudioConnectionConfig(
        {},
        {
          MODEL_REQUEST_TIMEOUT_MS: "12000",
          MODEL_PREDICTION_TIMEOUT_MS: "34000",
        },
      ).predictionTimeoutMs,
    ).toBe(12_000);
    expect(
      createLMStudioConnectionConfig({}, { MODEL_PREDICTION_TIMEOUT_MS: "34000" })
        .predictionTimeoutMs,
    ).toBe(34_000);
    expect(
      createLMStudioConnectionConfig(
        { predictionTimeoutMs: 56_000 },
        { MODEL_REQUEST_TIMEOUT_MS: "12000" },
      ).predictionTimeoutMs,
    ).toBe(56_000);
  });
});
