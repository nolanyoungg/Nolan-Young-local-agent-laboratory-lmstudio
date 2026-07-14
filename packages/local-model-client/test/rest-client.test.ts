import { describe, expect, it, vi } from "vitest";

import {
  LMStudioRestHealthClient,
  MAX_LM_STUDIO_REST_RESPONSE_BYTES,
  ModelClientError,
  ModelClientErrorCode,
  createLMStudioConnectionConfig,
  type FetchLike,
} from "../src/index.js";

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

describe("LMStudioRestHealthClient", () => {
  it("times out while reading a response body that never finishes", async () => {
    vi.useFakeTimers();
    try {
      const cancelBody = vi.fn();
      const client = new LMStudioRestHealthClient(
        createLMStudioConnectionConfig({ connectionTimeoutMs: 1_000 }),
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel: cancelBody,
            }),
            { status: 200 },
          ),
      );
      const listing = client.listModels();
      const observed = listing.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(observed).resolves.toMatchObject({
        code: ModelClientErrorCode.timeout,
        retryable: true,
      });
      await Promise.resolve();
      expect(cancelBody).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a response body that exceeds the finite byte limit", async () => {
    const oversizedBody = new Uint8Array(MAX_LM_STUDIO_REST_RESPONSE_BYTES + 1);
    const client = new LMStudioRestHealthClient(createLMStudioConnectionConfig(), async () =>
      Promise.resolve(new Response(oversizedBody, { status: 200 })),
    );

    await expect(client.listModels()).rejects.toMatchObject({
      code: ModelClientErrorCode.invalidResponse,
      message: expect.stringContaining("byte limit"),
    });
  });

  it("calls the native localhost models endpoint and normalizes physical instances", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      json(
        {
          models: [
            {
              key: "qwen/coder",
              display_name: "Qwen Coder",
              type: "llm",
              format: "gguf",
              capabilities: { structured_output: true, vision: false },
              loaded_instances: [
                { id: "win", device: "Windows", config: { context_length: 16_384 } },
                { id: "mac", device_name: "Mac", context_length: 32_768 },
              ],
            },
          ],
        },
        200,
        { "x-lm-studio-version": "0.4.2" },
      ),
    );
    const client = new LMStudioRestHealthClient(createLMStudioConnectionConfig(), fetchMock);
    const result = await client.listModels();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:1234/api/v1/models");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
    expect(result.apiVersion).toBe("0.4.2");
    expect(result.models).toMatchObject([
      { logicalKey: "qwen/coder", variantId: "win", device: "Windows", loaded: true },
      { logicalKey: "qwen/coder", variantId: "mac", device: "Mac", loaded: true },
    ]);
  });

  it("allows optional model metadata to be absent", async () => {
    const client = new LMStudioRestHealthClient(createLMStudioConnectionConfig(), async () =>
      json({ models: [{ key: "minimal" }] }),
    );
    await expect(client.listModels()).resolves.toMatchObject({
      models: [
        {
          logicalKey: "minimal",
          variantId: "minimal",
          displayName: "minimal",
          type: "llm",
          capabilities: [],
        },
      ],
    });
  });

  it("sends a token only as a Bearer header and classifies rejection", async () => {
    const token = "not-for-output";
    const fetchMock = vi.fn<FetchLike>(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      return json({ error: "unauthorized" }, 401);
    });
    const client = new LMStudioRestHealthClient(
      createLMStudioConnectionConfig({ apiToken: token }),
      fetchMock,
    );
    const health = await client.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.error?.code).toBe(ModelClientErrorCode.invalidToken);
    expect(JSON.stringify(health)).not.toContain(token);
  });

  it("distinguishes an authentication requirement when no token is configured", async () => {
    const client = new LMStudioRestHealthClient(createLMStudioConnectionConfig(), async () =>
      json({}, 401),
    );
    const health = await client.healthCheck();
    expect(health.authentication).toBe("required");
    expect(health.error?.code).toBe(ModelClientErrorCode.authenticationRequired);
  });

  it("detects unsupported native API versions and response shapes", async () => {
    const old = new LMStudioRestHealthClient(createLMStudioConnectionConfig(), async () =>
      json({ models: [] }, 200, { "x-lm-studio-version": "0.3.29" }),
    );
    await expect(old.listModels()).rejects.toMatchObject({
      code: ModelClientErrorCode.incompatibleVersion,
    });

    const malformed = new LMStudioRestHealthClient(createLMStudioConnectionConfig(), async () =>
      json({ unexpected: [] }),
    );
    await expect(malformed.listModels()).rejects.toMatchObject({
      code: ModelClientErrorCode.invalidResponse,
    });

    const legacy = new LMStudioRestHealthClient(
      createLMStudioConnectionConfig({ apiToken: "local-token" }),
      async () => json({ error: "not found" }, 404),
    );
    await expect(legacy.listModels()).rejects.toMatchObject({
      code: ModelClientErrorCode.incompatibleVersion,
      message: expect.stringContaining("0.4.0 or newer"),
    });
  });

  it("classifies endpoint failures without leaking their raw message", async () => {
    const client = new LMStudioRestHealthClient(
      createLMStudioConnectionConfig({ apiToken: "private-token" }),
      async () => {
        throw new Error("connection failed with Bearer private-token");
      },
    );
    const health = await client.healthCheck();
    expect(health.error?.code).toBe(ModelClientErrorCode.endpointUnavailable);
    expect(JSON.stringify(health)).not.toContain("private-token");
  });

  it("does not retain a secret-bearing fetch failure as an error cause", async () => {
    const token = "cause-private-token";
    const client = new LMStudioRestHealthClient(
      createLMStudioConnectionConfig({ apiToken: token }),
      async () => {
        throw new Error(`socket failed with Bearer ${token}`);
      },
    );
    const failure = await client.listModels().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelClientError);
    expect((failure as Error).cause).toBeUndefined();
    expect(String(failure)).not.toContain(token);
  });

  it("redacts a token even when a nested typed error repeats it", async () => {
    const token = "nested-private-token";
    const client = new LMStudioRestHealthClient(
      createLMStudioConnectionConfig({ apiToken: token }),
      async () => {
        throw new ModelClientError(
          ModelClientErrorCode.endpointUnavailable,
          `fetch failed with authorization: Bearer ${token}`,
          { retryable: true },
        );
      },
    );
    const health = await client.healthCheck();
    expect(health.error?.code).toBe(ModelClientErrorCode.endpointUnavailable);
    expect(JSON.stringify(health)).not.toContain(token);
    expect(health.error?.message).toContain("[REDACTED]");
  });
});
