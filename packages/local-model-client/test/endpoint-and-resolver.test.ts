import { describe, expect, it } from "vitest";

import {
  LMStudioModelResolver,
  ModelClientError,
  validateLMStudioEndpoint,
  type AvailableModel,
} from "../src/index.js";

function model(logicalKey: string, variantId: string, displayName = logicalKey): AvailableModel {
  return {
    logicalKey,
    variantId,
    displayName,
    type: "llm",
    capabilities: [],
  };
}

describe("validateLMStudioEndpoint", () => {
  it.each(["http://127.0.0.1:1234", "http://localhost:2345/", "http://[::1]:3456"])(
    "accepts and canonicalizes loopback endpoint %s",
    (input) => {
      const endpoint = validateLMStudioEndpoint(input);
      expect(endpoint.httpBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(endpoint.sdkWebSocketUrl).toBe(endpoint.httpBaseUrl.replace("http://", "ws://"));
    },
  );

  it.each([
    "https://127.0.0.1:1234",
    "http://192.168.1.50:1234",
    "http://mac.local:1234",
    "http://user:password@127.0.0.1:1234",
    "http://127.0.0.1:1234/api",
    "http://127.0.0.1:1234?token=secret",
    "http://127.0.0.1:1234#fragment",
  ])("rejects unsafe endpoint %s", (input) => {
    expect(() => validateLMStudioEndpoint(input)).toThrow(ModelClientError);
  });
});

describe("LMStudioModelResolver", () => {
  const resolver = new LMStudioModelResolver();

  it("collapses physical duplicates for an exact logical key", () => {
    const result = resolver.resolve("qwen/coder", [
      { ...model("qwen/coder", "windows-instance"), device: "Windows" },
      { ...model("qwen/coder", "mac-instance"), device: "Mac" },
    ]);
    expect(result.logicalKey).toBe("qwen/coder");
    expect(result.variants).toHaveLength(2);
    expect(result.matchType).toBe("exact-key");
  });

  it("accepts an exact selected variant ID", () => {
    const result = resolver.resolve("mac-instance", [
      model("qwen/coder", "windows-instance"),
      model("qwen/coder", "mac-instance"),
    ]);
    expect(result.selectedVariantId).toBe("mac-instance");
    expect(result.matchType).toBe("exact-variant");
  });

  it("does not normalize near-miss variant IDs", () => {
    expect(() =>
      resolver.resolve("mac instance", [
        model("qwen/coder", "windows-instance"),
        model("qwen/coder", "mac-instance"),
      ]),
    ).toThrow(/not visible/u);
  });

  it("rejects normalized names that map to distinct logical keys", () => {
    expect(() =>
      resolver.resolve("Qwen Coder", [
        model("publisher-a/qwen", "a", "Qwen Coder"),
        model("publisher-b/qwen", "b", "Qwen Coder"),
      ]),
    ).toThrow(/multiple logical model keys/u);
  });

  it("reports missing and empty inventories clearly", () => {
    expect(() => resolver.resolve("missing", [model("present", "present")])).toThrow(
      /not visible/u,
    );
    expect(() => resolver.resolve("present", [])).toThrow(/no visible/u);
  });
});
