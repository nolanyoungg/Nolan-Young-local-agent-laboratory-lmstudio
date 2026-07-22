import { describe, expect, it } from "vitest";

import {
  AUTO_SELECT_LOADED_MODEL,
  LMStudioModelResolver,
  createLMStudioConnectionConfig,
  createLMStudioModelClient,
  type AvailableModel,
} from "../src/index.js";

function model(logicalKey: string, loaded: boolean): AvailableModel {
  return {
    logicalKey,
    variantId: logicalKey,
    displayName: logicalKey,
    type: "llm",
    loaded,
    capabilities: [],
  };
}

describe("automatic loaded-model selection", () => {
  it("defaults an unconfigured client to loaded-model selection", () => {
    const config = createLMStudioConnectionConfig({}, {});
    expect(config.requestedModel).toBe(AUTO_SELECT_LOADED_MODEL);
  });

  it("uses the only model already loaded by LM Studio", () => {
    const result = new LMStudioModelResolver().resolve(AUTO_SELECT_LOADED_MODEL, [
      model("qwen/qwen2.5-coder-14b", false),
      model("openai/gpt-oss-20b", true),
    ]);

    expect(result.logicalKey).toBe("openai/gpt-oss-20b");
    expect(result.selectedVariantId).toBe("openai/gpt-oss-20b");
  });

  it("reads loaded instances from LM Studio's native model inventory", async () => {
    const requestedUrls: string[] = [];
    const client = createLMStudioModelClient({
      config: { baseUrl: "http://127.0.0.1:1234/v1", requestedModel: AUTO_SELECT_LOADED_MODEL },
      environment: {},
      dependencies: {
        fetch: async (input) => {
          requestedUrls.push(String(input));
          return new Response(
            JSON.stringify({
              models: [
                { key: "qwen/qwen2.5-coder-14b", type: "llm", loaded_instances: [] },
                {
                  key: "openai/gpt-oss-20b",
                  type: "llm",
                  loaded_instances: [{ id: "openai/gpt-oss-20b" }],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    });

    await expect(client.resolveModel(AUTO_SELECT_LOADED_MODEL)).resolves.toMatchObject({
      logicalKey: "openai/gpt-oss-20b",
    });
    expect(requestedUrls).toEqual(["http://127.0.0.1:1234/api/v1/models"]);
  });

  it("refuses to fall back to an unloaded model", () => {
    expect(() =>
      new LMStudioModelResolver().resolve(AUTO_SELECT_LOADED_MODEL, [
        model("qwen/qwen2.5-coder-14b", false),
      ]),
    ).toThrow(/No loaded language model is available/);
  });

  it("requires an explicit model when several logical models are loaded", () => {
    expect(() =>
      new LMStudioModelResolver().resolve(AUTO_SELECT_LOADED_MODEL, [
        model("openai/gpt-oss-20b", true),
        model("qwen/qwen2.5-coder-14b", true),
      ]),
    ).toThrow(/Multiple loaded language models are available/);
  });
});
