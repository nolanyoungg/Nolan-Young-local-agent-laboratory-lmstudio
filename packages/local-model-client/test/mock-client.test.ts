import { z } from "zod";
import { describe, expect, it } from "vitest";

import { MockModelClient, ModelClientError, ModelClientErrorCode } from "../src/index.js";

describe("MockModelClient", () => {
  it("replays deterministic structured responses in order", async () => {
    const client = new MockModelClient({ responses: [{ step: 1 }, { step: 2 }] });
    const schema = z.object({ step: z.number().int() });
    await expect(
      client.complete({ messages: [{ role: "user", content: "first" }] }, schema),
    ).resolves.toMatchObject({ value: { step: 1 }, transport: "mock" });
    await expect(
      client.complete({ messages: [{ role: "user", content: "second" }] }, schema),
    ).resolves.toMatchObject({ value: { step: 2 }, transport: "mock" });
    expect(client.requests).toHaveLength(2);
    expect(client.remainingSteps).toBe(0);
  });

  it("scripts typed failures and never falls back automatically", async () => {
    const failure = new ModelClientError(
      ModelClientErrorCode.endpointUnavailable,
      "scripted disconnect",
      { retryable: true },
    );
    const client = new MockModelClient({ script: [{ kind: "error", error: failure }] });
    await expect(
      client.complete(
        { messages: [{ role: "user", content: "test" }] },
        z.object({ answer: z.string() }),
      ),
    ).rejects.toBe(failure);
    await expect(
      client.complete(
        { messages: [{ role: "user", content: "test" }] },
        z.object({ answer: z.string() }),
      ),
    ).rejects.toMatchObject({ code: ModelClientErrorCode.mockExhausted });
  });

  it("validates every scripted response", async () => {
    const client = new MockModelClient({ responses: [{ wrong: true }] });
    await expect(
      client.complete(
        { messages: [{ role: "user", content: "test" }] },
        z.object({ answer: z.string() }),
      ),
    ).rejects.toMatchObject({ code: ModelClientErrorCode.malformedResponse });
  });
});
