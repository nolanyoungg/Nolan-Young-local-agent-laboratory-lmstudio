import { createHash } from "node:crypto";
import { access, cp, lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBuildAssistantCli } from "../apps/build-assistant/src/cli.js";
import { runCodeEditorCli } from "../apps/code-editor/src/cli.js";
import { main as runReleaseEngineerCli } from "../apps/release-engineer/src/cli.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const fixtures = {
  codeEditor: path.join(repositoryRoot, "examples", "sample-node-project"),
  buildAssistant: path.join(repositoryRoot, "examples", "broken-typescript-project"),
  releaseEngineer: path.join(repositoryRoot, "examples", "sample-release-project"),
} as const;

interface SnapshotEntry {
  readonly path: string;
  readonly type: "directory" | "file";
  readonly mode: number;
  readonly modifiedMs: number;
  readonly bytes?: number;
  readonly sha256?: string;
}

interface SmokeWorkspace {
  readonly temporaryRoot: string;
  readonly targets: Readonly<{
    codeEditor: string;
    buildAssistant: string;
    releaseEngineer: string;
  }>;
  readonly reports: Readonly<{
    codeEditor: string;
    buildAssistant: string;
    releaseEngineer: string;
  }>;
}

async function main(): Promise<void> {
  const originalSnapshots = await snapshotFixtureMap(fixtures);
  const smoke = await prepareSmokeWorkspace();

  try {
    await smokeCodeEditor(smoke);
    await smokeBuildAssistant(smoke);
    await smokeReleaseEngineer(smoke);

    const finalOriginalSnapshots = await snapshotFixtureMap(fixtures);
    assertEqual(
      finalOriginalSnapshots,
      originalSnapshots,
      "Original example fixtures changed during mock smoke execution",
    );
    process.stdout.write("PASS mock smoke workflows; all original fixtures remained unchanged.\n");
  } finally {
    await rm(smoke.temporaryRoot, { recursive: true, force: true });
  }
}

async function prepareSmokeWorkspace(): Promise<SmokeWorkspace> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "local-agent-lab-mock-smoke-"));
  const targets = {
    codeEditor: path.join(temporaryRoot, "targets", "code-editor"),
    buildAssistant: path.join(temporaryRoot, "targets", "build-assistant"),
    releaseEngineer: path.join(temporaryRoot, "targets", "release-engineer"),
  } as const;
  const reports = {
    codeEditor: path.join(temporaryRoot, "reports", "code-editor"),
    buildAssistant: path.join(temporaryRoot, "reports", "build-assistant"),
    releaseEngineer: path.join(temporaryRoot, "reports", "release-engineer"),
  } as const;

  try {
    await Promise.all([
      cp(fixtures.codeEditor, targets.codeEditor, {
        recursive: true,
        errorOnExist: true,
        force: false,
      }),
      cp(fixtures.buildAssistant, targets.buildAssistant, {
        recursive: true,
        errorOnExist: true,
        force: false,
      }),
      cp(fixtures.releaseEngineer, targets.releaseEngineer, {
        recursive: true,
        errorOnExist: true,
        force: false,
      }),
    ]);
    return { temporaryRoot, targets, reports };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function smokeCodeEditor(smoke: SmokeWorkspace): Promise<void> {
  const before = await snapshotDirectory(smoke.targets.codeEditor);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCodeEditorCli(
    [
      "--workspace",
      smoke.targets.codeEditor,
      "--task",
      "Run the deterministic offline smoke inspection without changing files.",
      "--mode",
      "dry-run",
      "--mock",
      "--reports-root",
      smoke.reports.codeEditor,
    ],
    {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
    { configuration: { environment: {} } },
  );
  assert(exitCode === 0, `Code Editor mock smoke returned ${exitCode}: ${stderr.join("")}`);
  assert(
    stdout.join("").includes("repair-proposed"),
    "Code Editor did not report the expected dry-run proposal status",
  );
  assertEqual(
    await snapshotDirectory(smoke.targets.codeEditor),
    before,
    "Code Editor dry-run mutated its copied target",
  );

  const result = await readOnlyRunResult(smoke.reports.codeEditor);
  assert(result["success"] === true, "Code Editor final result was not successful");
  assert(
    result["status"] === "repair-proposed",
    "Code Editor final result did not retain dry-run proposal semantics",
  );
  process.stdout.write("PASS code-editor mock dry-run (exit 0, target unchanged).\n");
}

async function smokeBuildAssistant(smoke: SmokeWorkspace): Promise<void> {
  const before = await snapshotDirectory(smoke.targets.buildAssistant);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runBuildAssistantCli(
    [
      "--workspace",
      smoke.targets.buildAssistant,
      "--command",
      "build",
      "--mode",
      "dry-run",
      "--mock",
      "--json",
      "--reports-root",
      smoke.reports.buildAssistant,
    ],
    {
      io: {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
    },
  );
  assert(
    exitCode === 1,
    `Build Assistant dry-run must return 1 for an unverified repair proposal; received ${exitCode}: ${stderr.join("")}`,
  );
  const printed = asRecord(JSON.parse(stdout.join("")) as unknown, "Build Assistant JSON output");
  assert(
    printed["status"] === "failed",
    "Build Assistant dry-run proposal must not claim workflow success",
  );
  assert(
    printed["finalStatus"] === "repair-proposed-verification-not-executed",
    "Build Assistant did not report 'repair proposed, verification not executed'",
  );
  assertEqual(
    await snapshotDirectory(smoke.targets.buildAssistant),
    before,
    "Build Assistant dry-run mutated its copied target",
  );

  const result = await readOnlyRunResult(smoke.reports.buildAssistant);
  assert(
    result["finalStatus"] === "repair-proposed-verification-not-executed",
    "Build Assistant persisted an unexpected final status",
  );
  const changes = result["changedFiles"];
  assert(
    Array.isArray(changes) && changes.length > 0,
    "Build Assistant mock did not propose the fixture repair",
  );
  process.stdout.write(
    "PASS build-assistant mock dry-run (exit 1, repair proposed, verification not executed).\n",
  );
}

async function smokeReleaseEngineer(smoke: SmokeWorkspace): Promise<void> {
  const before = await snapshotDirectory(smoke.targets.releaseEngineer);
  const exitCode = await runReleaseEngineerCli([
    "release",
    "--workspace",
    smoke.targets.releaseEngineer,
    "--mode",
    "dry-run",
    "--provider",
    "mock",
    "--reports-root",
    smoke.reports.releaseEngineer,
  ]);
  assert(exitCode === 0, `Release Engineer mock dry-run returned ${exitCode}`);
  assertEqual(
    await snapshotDirectory(smoke.targets.releaseEngineer),
    before,
    "Release Engineer dry-run mutated its copied target",
  );

  const runDirectory = await singleRunDirectory(smoke.reports.releaseEngineer);
  const result = asRecord(
    JSON.parse(await readFile(path.join(runDirectory, "final-result.json"), "utf8")) as unknown,
    "Release Engineer final result",
  );
  assert(result["status"] === "succeeded", "Release Engineer dry-run did not succeed");
  assert(
    result["manifest"] !== undefined,
    "Release Engineer dry-run did not validate a planned manifest",
  );
  assert(
    result["archive"] === undefined && result["checksum"] === undefined,
    "Release Engineer dry-run emitted archive/checksum result metadata",
  );
  assert(
    (await readdir(path.join(runDirectory, "artifacts"))).length === 0,
    "Release Engineer dry-run emitted an artifact",
  );
  process.stdout.write(
    "PASS release-engineer mock dry-run (exit 0, manifest validated, no ZIP/checksum).\n",
  );
}

async function readOnlyRunResult(reportsRoot: string): Promise<Readonly<Record<string, unknown>>> {
  const runDirectory = await singleRunDirectory(reportsRoot);
  return asRecord(
    JSON.parse(await readFile(path.join(runDirectory, "final-result.json"), "utf8")) as unknown,
    `Final result under ${reportsRoot}`,
  );
}

async function singleRunDirectory(reportsRoot: string): Promise<string> {
  const entries = (await readdir(reportsRoot, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name !== ".locks" && entry.name !== "locks",
  );
  assert(
    entries.length === 1,
    `Expected exactly one run directory under ${reportsRoot}; found ${entries.length}`,
  );
  const entry = entries[0];
  if (entry === undefined) {
    throw new Error(`Run directory disappeared under ${reportsRoot}`);
  }
  return path.join(reportsRoot, entry.name);
}

async function snapshotFixtureMap(
  locations: Readonly<Record<string, string>>,
): Promise<Readonly<Record<string, readonly SnapshotEntry[]>>> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(locations).map(async ([name, location]) => [
        name,
        await snapshotDirectory(await realpath(location)),
      ]),
    ),
  );
}

async function snapshotDirectory(root: string): Promise<readonly SnapshotEntry[]> {
  await access(root);
  const entries: SnapshotEntry[] = [];

  async function visit(absoluteDirectory: string, relativeDirectory: string): Promise<void> {
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = path.join(absoluteDirectory, child.name);
      const relativePath = path.posix.join(relativeDirectory, child.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Fixture snapshots reject symbolic links: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        entries.push({
          path: relativePath,
          type: "directory",
          mode: metadata.mode,
          modifiedMs: metadata.mtimeMs,
        });
        await visit(absolutePath, relativePath);
      } else if (metadata.isFile()) {
        const content = await readFile(absolutePath);
        entries.push({
          path: relativePath,
          type: "file",
          mode: metadata.mode,
          modifiedMs: metadata.mtimeMs,
          bytes: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex"),
        });
      } else {
        throw new Error(`Fixture contains a non-regular entry: ${relativePath}`);
      }
    }
  }

  await visit(root, "");
  return entries;
}

function asRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} was not a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message);
  }
}

await main();
