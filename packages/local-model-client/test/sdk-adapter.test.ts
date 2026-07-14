import { describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  model: vi.fn(),
}));

vi.mock("@lmstudio/sdk", () => ({
  LMStudioClient: class {
    public readonly llm = { model: sdkMocks.model };
  },
}));

import { DefaultLMStudioSdkAdapter } from "../src/index.js";

describe("DefaultLMStudioSdkAdapter", () => {
  it("disables SDK progress logging so JSON diagnostics stay machine-readable", async () => {
    sdkMocks.model.mockResolvedValueOnce({ respond: vi.fn() });
    const signal = new AbortController().signal;
    const adapter = new DefaultLMStudioSdkAdapter();

    await adapter.loadModel({
      sdkWebSocketUrl: "ws://127.0.0.1:1234",
      model: "qwen/coder",
      contextLength: 32_768,
      signal,
    });

    expect(sdkMocks.model).toHaveBeenCalledWith("qwen/coder", {
      config: { contextLength: 32_768 },
      signal,
      verbose: false,
    });
  });
});
