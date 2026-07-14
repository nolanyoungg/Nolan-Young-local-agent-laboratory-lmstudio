import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  ProcessLogSnapshot,
  ProcessStatusSnapshot,
  WatcherHandle,
} from "@local-agent-lab/process-tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseBuildAssistantArguments,
  runBuildAssistant,
  runBuildAssistantCli,
  observeWatcher,
} from "../src/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  readonly root: string;
  readonly workspace: string;
  readonly reports: string;
  readonly commands: string;
  readonly source: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "build-assistant-"));
  temporaryRoots.push(root);
  const workspace = path.join(root, "workspace");
  const reports = path.join(root, "reports");
  const source = path.join(workspace, "src", "calculator.ts");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(
    source,
    "export function parseNumericInput(input: string): number {\n  return input;\n}\n",
    "utf8",
  );
  await writeFile(
    path.join(workspace, "build.mjs"),
    `import { readFileSync } from "node:fs";\nconst source = readFileSync("src/calculator.ts", "utf8");\nif (source.includes("return Number(input);")) { console.log("build succeeded"); process.exit(0); }\nconsole.error("src/calculator.ts: string is not assignable to number");\nprocess.exit(1);\n`,
    "utf8",
  );
  const commands = path.join(root, "commands.json");
  await writeFile(
    commands,
    `${JSON.stringify({ commands: { build: { kind: "node", args: ["build.mjs"], timeoutMs: 5_000 } } }, null, 2)}\n`,
    "utf8",
  );
  return { root, workspace, reports, commands, source };
}

describe("Build Assistant CLI", () => {
  it("requires the canonical workspace, command, and mode options", () => {
    expect(() => parseBuildAssistantArguments(["--workspace", "."])).toThrow(
      /--workspace, --command, and --mode/u,
    );
    expect(() =>
      parseBuildAssistantArguments([
        "--workspace",
        ".",
        "--command",
        "build",
        "--mode",
        "plan-only",
      ]),
    ).toThrow(/dry-run or apply/u);
  });

  it("returns help without starting a workflow", async () => {
    let output = "";
    const exitCode = await runBuildAssistantCli(["--help"], {
      io: { stdout: (value) => (output += value), stderr: () => undefined },
    });
    expect(exitCode).toBe(0);
    expect(output).toContain("--commands-file");
    expect(output).toContain("130 interrupted");
  });
});

describe("Build Assistant workflow", () => {
  it("keeps the target unchanged and marks dry-run verification unexecuted", async () => {
    const test = await fixture();
    const before = await readFile(test.source, "utf8");
    const result = await runBuildAssistant({
      workspace: test.workspace,
      commandId: "build",
      commandConfigurationPath: test.commands,
      reportsRoot: test.reports,
      mode: "dry-run",
      mock: true,
    });

    expect(result.status).toBe("failed");
    expect(result.finalStatus).toBe("repair-proposed-verification-not-executed");
    expect(result.changedFiles).toHaveLength(1);
    expect(await readFile(test.source, "utf8")).toBe(before);
    const journal = await readFile(path.join(result.runDirectory, "mutation-journal.json"), "utf8");
    expect(journal).toContain("fingerprint");
    expect(journal).not.toContain("return Number(input)");
  });

  it("applies, rebuilds, and reviews a repair", async () => {
    const test = await fixture();
    const result = await runBuildAssistant({
      workspace: test.workspace,
      commandId: "build",
      commandConfigurationPath: test.commands,
      reportsRoot: test.reports,
      mode: "apply",
      mock: true,
    });

    expect(result.status).toBe("succeeded");
    expect(result.finalStatus).toBe("verified");
    expect(result.passes).toHaveLength(1);
    expect(await readFile(test.source, "utf8")).toContain("return Number(input);");
    const trace = await readFile(path.join(result.runDirectory, "trace.jsonl"), "utf8");
    expect(trace).not.toContain("return Number(input)");
    const persistedNames = [
      "run-metadata.json",
      "final-result.json",
      "final-report.md",
      "build-attempts.json",
      "mutation-journal.json",
      "process-log-metadata.json",
      "process-logs.json",
      "trace.jsonl",
    ];
    for (const name of persistedNames) {
      const artifact = await readFile(path.join(result.runDirectory, name), "utf8");
      expect(artifact).not.toContain(test.workspace);
      expect(artifact).not.toContain(test.workspace.replaceAll("\\", "\\\\"));
      expect(artifact).not.toContain(result.runDirectory);
      expect(artifact).not.toContain(result.runDirectory.replaceAll("\\", "\\\\"));
    }
    const events = trace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
    const authorizationIndex = events.findIndex(
      (event) => event["type"] === "mutation_authorization",
    );
    const mutationIndex = events.findIndex((event) => event["type"] === "mutation");
    expect(authorizationIndex).toBeGreaterThanOrEqual(0);
    expect(mutationIndex).toBeGreaterThan(authorizationIndex);
  });
});

describe("watcher observation", () => {
  it("uses trusted literal patterns and settled bounded deltas", async () => {
    let reads = 0;
    const snapshots: ProcessLogSnapshot[] = [
      {
        stdout: "watching\n",
        stderr: "",
        stdoutTail: "watching\n",
        stderrTail: "",
        stdoutBytes: 9,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        truncated: false,
      },
      {
        stdout: "watching\nbuild succeeded\n",
        stderr: "",
        stdoutTail: "watching\nbuild succeeded\n",
        stderrTail: "",
        stdoutBytes: 25,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        truncated: false,
      },
    ];
    const status: ProcessStatusSnapshot = {
      commandId: "dev",
      pid: 1234,
      status: "running",
      startedAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      exitCode: null,
      signal: null,
    };
    const handle: WatcherHandle = {
      commandId: "dev",
      pid: 1234,
      getLogs: () => snapshots[Math.min(reads++, snapshots.length - 1)] as ProcessLogSnapshot,
      getStatus: () => status,
      stop: async () => undefined,
      waitForExit: async () => await new Promise(() => undefined),
    };

    const result = await observeWatcher(
      handle,
      {
        readyPatterns: ["watching"],
        successPatterns: ["BUILD SUCCEEDED"],
        failurePatterns: ["build failed"],
        settleMs: 5,
      },
      {
        timeoutMs: 200,
        offsets: { stdoutBytes: 0, stderrBytes: 0 },
        pollMs: 1,
      },
    );
    expect(result.observation.status).toBe("succeeded");
    expect(result.observation.matchedPattern).toBe("BUILD SUCCEEDED");
  });
});
