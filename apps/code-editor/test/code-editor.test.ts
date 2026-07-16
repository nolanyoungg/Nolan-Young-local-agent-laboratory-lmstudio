import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MockModelClient } from "@local-agent-lab/local-model-client";
import { afterEach, describe, expect, it } from "vitest";

import {
  CodeEditorUsageError,
  loadCodeEditorConfig,
  parseCliArguments,
} from "../src/Configuration.js";
import { runCodeEditor } from "../src/CodeEditorWorkflow.js";
import { runCodeEditorCli } from "../src/cli.js";
import type { CodeEditorMode } from "../src/types.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

describe("code editor CLI", () => {
  it("requires explicit values and rejects conflicting modes", async () => {
    expect(() =>
      parseCliArguments([
        "--workspace",
        "fixture",
        "--task",
        "edit",
        "--mode",
        "apply",
        "--dry-run",
      ]),
    ).toThrow(CodeEditorUsageError);
    expect(() => parseCliArguments(["--unknown"])).toThrow(CodeEditorUsageError);

    const errors: string[] = [];
    const exit = await runCodeEditorCli([], {
      stdout: () => undefined,
      stderr: (message) => errors.push(message),
    });
    expect(exit).toBe(2);
    expect(errors.join("")).toContain("--workspace is required");
  });

  it("returns help without loading a workspace", async () => {
    const output: string[] = [];
    const exit = await runCodeEditorCli(["--help"], {
      stdout: (message) => output.push(message),
      stderr: () => undefined,
    });
    expect(exit).toBe(0);
    expect(output.join("")).toContain("--mode <mode>");
  });
});

describe("code editor workflow", () => {
  it("locks plan-only runs and writes an empty diff with skipped execution", async () => {
    const fixture = await createFixture();
    const config = await configurationFor(fixture, "plan-only");
    const outcome = await runCodeEditor(config);

    expect(outcome.success).toBe(true);
    expect(outcome.editingSkipped).toBe(true);
    expect(outcome.reviewSkipped).toBe(true);
    expect(
      await readFile(path.join(outcome.runDirectory.path, "proposed-diff.patch"), "utf8"),
    ).toBe("");
    expect(
      await readFile(path.join(outcome.runDirectory.path, "review-report.md"), "utf8"),
    ).toContain("skipped in plan-only mode");
    expect(await readdir(path.join(fixture.reports, ".locks"))).toEqual([]);
  });

  it("shares dry-run edits with the reviewer and leaves the target unchanged", async () => {
    const fixture = await createFixture();
    const config = await configurationFor(fixture, "dry-run");
    const client = new MockModelClient({
      responses: mutationScript("virtual.ts"),
    });
    const before = await readdir(fixture.workspace);
    const outcome = await runCodeEditor(config, { modelClient: client });

    expect(outcome.success).toBe(true);
    expect(outcome.changedFiles).toEqual([
      expect.objectContaining({ path: "virtual.ts", change: "created", dryRun: true }),
    ]);
    expect(outcome.proposedDiff).toContain("+++ b/virtual.ts");
    expect(outcome.proposedDiff).toContain("export const virtual = true;");
    expect(await readdir(fixture.workspace)).toEqual(before);
    await expect(access(path.join(fixture.workspace, "virtual.ts"))).rejects.toBeDefined();

    const mutationMetadata = JSON.parse(
      await readFile(path.join(outcome.runDirectory.path, "mutation-metadata.json"), "utf8"),
    ) as {
      operations: readonly {
        callId: string;
        tool: string;
        fingerprint: string;
        path: string;
        dryRun: boolean;
      }[];
    };
    expect(mutationMetadata.operations).toEqual([
      expect.objectContaining({
        callId: "editor:editor-create",
        tool: "create_file",
        path: "virtual.ts",
        dryRun: true,
      }),
    ]);
    expect(mutationMetadata.operations[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("applies atomic file changes without invoking git", async () => {
    const fixture = await createFixture();
    const config = await configurationFor(fixture, "apply");
    const outcome = await runCodeEditor(config, {
      modelClient: new MockModelClient({ responses: mutationScript("applied.ts") }),
    });

    expect(outcome.success).toBe(true);
    expect(await readFile(path.join(fixture.workspace, "applied.ts"), "utf8")).toBe(
      "export const virtual = true;\n",
    );
    expect(outcome.changedFiles[0]).toMatchObject({
      path: "applied.ts",
      dryRun: false,
    });
  });

  it("bounds review and repair execution to three review passes", async () => {
    const fixture = await createFixture();
    const config = await configurationFor(fixture, "dry-run");
    const responses: unknown[] = [plannerCompletion(), editorCompletion()];
    for (let pass = 1; pass <= 3; pass += 1) {
      responses.push(rejectedReview(pass));
      if (pass < 3) {
        responses.push(editorCompletion());
      }
    }
    const outcome = await runCodeEditor(config, {
      modelClient: new MockModelClient({ responses }),
    });

    expect(outcome.success).toBe(false);
    expect(outcome.status).toBe("review-failed");
    expect(outcome.reviews).toHaveLength(3);
    expect(outcome.editorRuns).toHaveLength(3);
  });

  it("rejects report and lock roots inside the target before creating them", async () => {
    const fixture = await createFixture();
    const unsafeReports = path.join(fixture.workspace, "reports-inside");
    const config = await loadCodeEditorConfig(
      parseCliArguments([
        "--workspace",
        fixture.workspace,
        "--task",
        "inspect",
        "--mode",
        "plan-only",
        "--mock",
        "--reports-root",
        unsafeReports,
      ]),
      { environment: {} },
    );

    await expect(runCodeEditor(config)).rejects.toThrow(CodeEditorUsageError);
    await expect(access(unsafeReports)).rejects.toBeDefined();
  });
});

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly reports: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "code-editor-app-"));
  temporaryRoots.push(root);
  const workspace = path.join(root, "workspace");
  const reports = path.join(root, "reports");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "index.ts"), "export const existing = true;\n", "utf8");
  return { root, workspace, reports };
}

async function configurationFor(fixture: Fixture, mode: CodeEditorMode) {
  return loadCodeEditorConfig(
    parseCliArguments([
      "--workspace",
      fixture.workspace,
      "--task",
      "Add the requested fixture file",
      "--mode",
      mode,
      "--mock",
      "--reports-root",
      fixture.reports,
    ]),
    { environment: {} },
  );
}

function mutationScript(file: string): readonly unknown[] {
  return [
    plannerCompletion(),
    {
      kind: "tool_call",
      callId: "editor-create",
      tool: "create_file",
      input: { path: file, content: "export const virtual = true;\n" },
    },
    {
      kind: "complete",
      summary: "Created the requested file.",
      evidence: [file],
      findings: [],
      changedFiles: [file],
    },
    {
      kind: "tool_call",
      callId: "reviewer-read",
      tool: "read_file",
      input: { path: file },
    },
    {
      kind: "complete",
      summary: "The confined file contains the requested export.",
      evidence: [file],
      findings: [],
      approved: true,
      requiredChanges: [],
    },
  ];
}

function plannerCompletion() {
  return {
    kind: "complete",
    summary: "Create one focused fixture file.",
    evidence: ["index.ts establishes the fixture style."],
    findings: [],
    changePlan: [
      {
        action: "Create the requested file",
        rationale: "The task requests a new fixture module.",
        acceptanceCriteria: ["The new module is readable in the confined workspace."],
      },
    ],
  };
}

function editorCompletion() {
  return {
    kind: "complete",
    summary: "No further safe changes were available.",
    evidence: [],
    findings: [],
    changedFiles: [],
  };
}

function rejectedReview(pass: number) {
  return {
    kind: "complete",
    summary: `Review pass ${pass} requires another repair.`,
    evidence: ["The requested behavior is still absent."],
    findings: [
      {
        severity: "error",
        message: "The task remains incomplete.",
        evidence: ["No changed file was observed."],
      },
    ],
    approved: false,
    requiredChanges: ["Implement the requested behavior."],
  };
}
