import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createLMStudioConnectionConfig,
  createLMStudioModelClient,
  LMStudioHealthCheck,
} from "@local-agent-lab/local-model-client";

import { runBuildAssistantCli } from "../apps/build-assistant/src/cli.js";
import { runCodeEditorCli } from "../apps/code-editor/src/cli.js";
import { main as runReleaseEngineerCli } from "../apps/release-engineer/src/cli.js";

const MODEL = "openai/gpt-oss-20b";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertExpectedExit(actual: number, expected: number, label: string): void {
  assert(actual === expected, `${label} returned ${actual}; expected ${expected}.`);
}

async function snapshot(root: string): Promise<Readonly<Record<string, string>>> {
  const entries: Record<string, string> = {};
  async function visit(directory: string, relative: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = path.posix.join(relative, child.name);
      const childPath = path.join(directory, child.name);
      if (child.isDirectory()) await visit(childPath, childRelative);
      else if (child.isFile()) {
        entries[childRelative] = createHash("sha256")
          .update(await readFile(childPath))
          .digest("hex");
      } else {
        throw new Error(`Acceptance fixture contains a non-regular entry: ${childRelative}`);
      }
    }
  }
  await visit(root, "");
  return entries;
}

async function runDirectoryResult(reports: string): Promise<Readonly<Record<string, unknown>>> {
  const directories = (await readdir(reports, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  const run = directories.find((entry) => entry.name !== ".locks" && entry.name !== "locks");
  assert(run !== undefined, `Expected one run directory under ${reports}.`);
  return JSON.parse(
    await readFile(path.join(reports, run.name, "final-result.json"), "utf8"),
  ) as Record<string, unknown>;
}

async function preflight(): Promise<void> {
  const client = createLMStudioModelClient({
    config: createLMStudioConnectionConfig({ requestedModel: MODEL }),
  });
  const summary = await new LMStudioHealthCheck(client).run({ runInference: true });
  assert(
    summary.ok,
    `LM Studio preflight failed for ${MODEL}. Run npm run check:lmstudio -- --model ${MODEL} --inference.`,
  );
}

async function main(): Promise<void> {
  await preflight();
  const root = await mkdtemp(path.join(tmpdir(), "local-agent-live-acceptance-"));
  const codeWorkspace = path.join(root, "code-editor");
  const buildWorkspace = path.join(root, "build-assistant");
  const releaseWorkspace = path.join(root, "release-engineer");
  const reports = path.join(root, "reports");
  try {
    await Promise.all([
      cp(path.join(repositoryRoot, "examples", "sample-node-project"), codeWorkspace, {
        recursive: true,
      }),
      cp(path.join(repositoryRoot, "examples", "broken-typescript-project"), buildWorkspace, {
        recursive: true,
      }),
      cp(path.join(repositoryRoot, "examples", "sample-release-project"), releaseWorkspace, {
        recursive: true,
      }),
    ]);
    const codeBefore = await snapshot(codeWorkspace);
    const codeExit = await runCodeEditorCli(
      [
        "--workspace",
        codeWorkspace,
        "--task",
        "Create live-acceptance.txt containing exactly: live acceptance followed by one newline.",
        "--mode",
        "dry-run",
        "--model",
        MODEL,
        "--reports-root",
        path.join(reports, "code-editor"),
      ],
      { stdout: () => undefined, stderr: () => undefined },
    );
    assertExpectedExit(codeExit, 0, "Code Editor");
    assert(
      JSON.stringify(await snapshot(codeWorkspace)) === JSON.stringify(codeBefore),
      "Code Editor dry-run changed its target.",
    );
    assert(
      (await runDirectoryResult(path.join(reports, "code-editor")))["success"] === true,
      "Code Editor did not report success.",
    );

    const buildBefore = await snapshot(buildWorkspace);
    const buildExit = await runBuildAssistantCli(
      [
        "--workspace",
        buildWorkspace,
        "--command",
        "build",
        "--mode",
        "dry-run",
        "--model",
        MODEL,
        "--reports-root",
        path.join(reports, "build-assistant"),
      ],
      { io: { stdout: () => undefined, stderr: () => undefined } },
    );
    assertExpectedExit(buildExit, 1, "Build Assistant");
    assert(
      JSON.stringify(await snapshot(buildWorkspace)) === JSON.stringify(buildBefore),
      "Build Assistant dry-run changed its target.",
    );
    assert(
      (await runDirectoryResult(path.join(reports, "build-assistant")))["finalStatus"] ===
        "repair-proposed-verification-not-executed",
      "Build Assistant did not report an unverified repair proposal.",
    );

    await rm(path.join(releaseWorkspace, "README.md"));
    const releaseBefore = await snapshot(releaseWorkspace);
    const releaseExit = await runReleaseEngineerCli([
      "prepare",
      "--workspace",
      releaseWorkspace,
      "--mode",
      "dry-run",
      "--repair",
      "--task",
      "Repair only the missing README.md required by deterministic checks.",
      "--provider",
      "lmstudio",
      "--model",
      MODEL,
      "--reports-root",
      path.join(reports, "release-engineer"),
    ]);
    assertExpectedExit(releaseExit, 0, "Release Engineer");
    assert(
      JSON.stringify(await snapshot(releaseWorkspace)) === JSON.stringify(releaseBefore),
      "Release Engineer dry-run changed its target.",
    );
    assert(
      (await runDirectoryResult(path.join(reports, "release-engineer")))["status"] === "succeeded",
      "Release Engineer did not repair the virtual release fixture.",
    );
    process.stdout.write(
      "PASS live acceptance: Code Editor, Build Assistant, and Release Engineer.\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
