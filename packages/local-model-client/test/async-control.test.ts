import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { runWithDeadline } from "../src/async-control.js";
import { ModelClientError, ModelClientErrorCode } from "../src/errors.js";

const execFileAsync = promisify(execFile);

describe("model operation liveness", () => {
  it("reports a deadline as TIMEOUT when the operation rejects on signal abort", async () => {
    vi.useFakeTimers();
    try {
      const completion = runWithDeadline(
        "signal-aware operation",
        1_000,
        undefined,
        async (signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () =>
                reject(
                  new ModelClientError(
                    ModelClientErrorCode.cancelled,
                    "The adapter observed cancellation.",
                  ),
                ),
              { once: true },
            );
          }),
      );
      const observed = completion.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(observed).resolves.toMatchObject({
        code: ModelClientErrorCode.timeout,
        retryable: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a never-settling operation alive until its typed deadline fires", async () => {
    const moduleUrl = new URL("../src/async-control.ts", import.meta.url).href;
    const script = `
      import { abortableDelay, runWithDeadline } from ${JSON.stringify(moduleUrl)};

      try {
        await runWithDeadline(
          "liveness probe",
          50,
          undefined,
          async () => new Promise(() => undefined),
        );
        throw new Error("The never-settling operation unexpectedly resolved.");
      } catch (error) {
        if (error?.code !== "TIMEOUT") throw error;
        process.stdout.write(error.code);
      }

      await abortableDelay(50);
      process.stdout.write(":delay-complete");
    `;

    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { timeout: 5_000, windowsHide: true },
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("TIMEOUT:delay-complete");
  });
});
