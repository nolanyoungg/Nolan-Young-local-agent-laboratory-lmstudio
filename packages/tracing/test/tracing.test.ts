import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JsonlTraceWriter,
  RunDirectoryManager,
  TraceRecorder,
  redact,
  sanitizedError,
} from "../src/index.js";

describe("tracing", () => {
  it("recursively redacts secret values", () => {
    expect(
      redact({ apiToken: "lm_secretvalue", nested: { authorization: "Bearer abc.def" } }),
    ).toEqual({ apiToken: "[REDACTED]", nested: { authorization: "[REDACTED]" } });
  });

  it("removes embedded canonical paths from sanitized errors", () => {
    const error = Object.assign(
      new Error("Unable to read C:\\Users\\operator\\secret-project\\file.ts"),
      { code: "IO_ERROR" },
    );
    expect(sanitizedError(error)).toEqual({
      name: "Error",
      message: "Unable to read [ABSOLUTE PATH REDACTED]",
      code: "IO_ERROR",
    });
  });

  it("creates Windows-safe run directories and metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-tracing-"));
    const manager = new RunDirectoryManager(
      root,
      undefined,
      () => new Date("2026-07-13T12:34:56.789Z"),
      () => "run-id",
    );
    const run = await manager.create({
      application: "code-editor",
      workspaceRoot: root,
      modelProvider: "mock",
      requestedModel: "mock-model",
      mode: "dry-run",
    });
    expect(run.path).toContain("20260713T123456789Z-code-editor-run-id");
    expect(JSON.parse(await readFile(run.metadataPath, "utf8"))).toMatchObject({ runId: "run-id" });
  });

  it("serializes trace events in order", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-trace-events-"));
    const path = join(root, "trace.jsonl");
    const recorder = new TraceRecorder(
      new JsonlTraceWriter(path),
      () => new Date("2026-07-13T00:00:00Z"),
    );
    await Promise.all([
      recorder.record({ type: "workflow", status: "started", runId: "one" }),
      recorder.record({ type: "workflow", status: "completed", runId: "one" }),
    ]);
    await recorder.close();
    const events = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sequence: number });
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
  });
});
