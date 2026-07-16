import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MockModelClient } from "@local-agent-lab/local-model-client";

import { ReleaseEngineerWorkflow } from "../src/ReleaseEngineerWorkflow.js";
import type { ReleasePolicies } from "../src/types.js";

const policies: ReleasePolicies = {
  checks: {
    requiredPackageFields: ["name", "version"],
    requiredFiles: ["package.json", "README.md", "LICENSE"],
    forbiddenGlobs: [
      ".git/**",
      ".env*",
      "**/.env*",
      "node_modules/**",
      "reports/**",
      "*.pem",
      "*.key",
    ],
  },
  packaging: {
    include: ["package.json", "README.md", "LICENSE", "dist/**", "src/**"],
    exclude: [
      ".git/**",
      ".env*",
      "**/.env*",
      "node_modules/**",
      "reports/**",
      "*.zip",
      "*.pem",
      "*.key",
    ],
    maximumEntries: 1_000,
    maximumArchiveBytes: 16_777_216,
  },
  permissions: {
    repairer: [
      "list_files",
      "read_file",
      "read_file_metadata",
      "search_text",
      "create_file",
      "write_file",
      "apply_patch",
    ],
    reviewer: ["list_files", "read_file", "read_file_metadata", "search_text"],
  },
  protectedWorkspacePaths: [],
};

const temporaryRoots: string[] = [];

async function createFixture(): Promise<{
  readonly root: string;
  readonly workspace: string;
  readonly reports: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "release-engineer-"));
  temporaryRoots.push(root);
  const workspace = path.join(root, "workspace");
  const reports = path.join(root, "trusted-reports");
  await Promise.all([
    mkdir(path.join(workspace, "src"), { recursive: true }),
    mkdir(path.join(workspace, "dist"), { recursive: true }),
    mkdir(reports, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(workspace, "package.json"),
      `${JSON.stringify(
        {
          name: "fixture-package",
          version: "1.2.3",
          description: "A release fixture",
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(path.join(workspace, "README.md"), "# Fixture\n"),
    writeFile(path.join(workspace, "LICENSE"), "MIT\n"),
    writeFile(path.join(workspace, "src", "index.js"), "export const value = 1;\n"),
    writeFile(path.join(workspace, "dist", "index.js"), "export const value = 1;\n"),
  ]);
  return { root, workspace, reports };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ReleaseEngineerWorkflow", () => {
  it("runs authoritative model-free checks", async () => {
    const fixture = await createFixture();
    const result = await new ReleaseEngineerWorkflow({
      action: "check",
      mode: "dry-run",
      workspace: fixture.workspace,
      reportsRoot: fixture.reports,
      policies,
      repair: false,
    }).run();

    expect(result.status).toBe("succeeded");
    expect(result.checks.passed).toBe(true);
    expect(result.manifest).toBeUndefined();
    expect(result.runDirectory).not.toContain(fixture.reports);
    expect(result.workspace.name).toBe("workspace");
    expect(result.workspace.identitySha256).toMatch(/^[a-f0-9]{64}$/u);
    const diagnostics = JSON.parse(
      await readFile(
        path.join(fixture.reports, result.runDirectory, "model-diagnostics.json"),
        "utf8",
      ),
    ) as { status: string };
    expect(diagnostics.status).toBe("SKIPPED");
    const persistedMetadata = await readFile(
      path.join(fixture.reports, result.runDirectory, "run-metadata.json"),
      "utf8",
    );
    const persistedResult = await readFile(
      path.join(fixture.reports, result.runDirectory, "final-result.json"),
      "utf8",
    );
    expect(persistedMetadata).not.toContain(fixture.workspace);
    expect(persistedResult).not.toContain(fixture.workspace);
    const emptyJournal = JSON.parse(
      await readFile(
        path.join(fixture.reports, result.runDirectory, "mutation-journal.json"),
        "utf8",
      ),
    ) as { version: number; mutations: unknown[] };
    expect(emptyJournal).toEqual({ version: 1, mutations: [] });
    const trace = await readFile(
      path.join(fixture.reports, result.runDirectory, "trace.jsonl"),
      "utf8",
    );
    expect(trace).not.toContain(fixture.workspace);
  });

  it("accepts a project with installed dependencies and a LICENSE.txt variant", async () => {
    const fixture = await createFixture();
    await rename(
      path.join(fixture.workspace, "LICENSE"),
      path.join(fixture.workspace, "LICENSE.txt"),
    );
    await mkdir(path.join(fixture.workspace, "node_modules", "example"), { recursive: true });
    await writeFile(
      path.join(fixture.workspace, "node_modules", "example", "index.js"),
      "export {};\n",
    );

    const result = await new ReleaseEngineerWorkflow({
      action: "check",
      mode: "dry-run",
      workspace: fixture.workspace,
      reportsRoot: fixture.reports,
      policies,
      repair: false,
    }).run();

    expect(result.status).toBe("succeeded");
    expect(result.checks.passed).toBe(true);
  });

  it("fails checks when forbidden secret-bearing files are present", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.workspace, ".env.production"), "TOKEN=do-not-package\n");

    const result = await new ReleaseEngineerWorkflow({
      action: "check",
      mode: "dry-run",
      workspace: fixture.workspace,
      reportsRoot: fixture.reports,
      policies,
      repair: false,
    }).run();

    expect(result.status).toBe("failed");
    expect(result.checks.findings).toContainEqual(
      expect.objectContaining({
        code: "FORBIDDEN_WORKSPACE_ENTRY",
        path: ".env.production",
      }),
    );
  });

  it("produces identical ZIP bytes and checksums for the same workspace", async () => {
    const fixture = await createFixture();
    const runRelease = async () =>
      new ReleaseEngineerWorkflow({
        action: "release",
        mode: "apply",
        workspace: fixture.workspace,
        reportsRoot: fixture.reports,
        policies,
        repair: false,
      }).run();

    const first = await runRelease();
    const second = await runRelease();
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    expect(first.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.checksum).toBe(first.checksum);
    expect(first.manifest?.entries.map((entry) => entry.path)).toEqual([
      "dist/index.js",
      "LICENSE",
      "package.json",
      "README.md",
      "src/index.js",
    ]);
    expect(first.archive?.entries).toHaveLength(5);
    expect(first.archive?.archivePath).toBe("artifacts/fixture-package-1.2.3.zip");
    expect(
      await readFile(
        path.join(fixture.reports, first.runDirectory, first.checksumPath as string),
        "utf8",
      ),
    ).toBe(`${first.checksum}  fixture-package-1.2.3.zip\n`);
  });

  it("keeps dry-run target and artifact directory unchanged", async () => {
    const fixture = await createFixture();
    const packageBefore = await readFile(path.join(fixture.workspace, "package.json"), "utf8");
    const result = await new ReleaseEngineerWorkflow({
      action: "release",
      mode: "dry-run",
      workspace: fixture.workspace,
      reportsRoot: fixture.reports,
      policies,
      repair: false,
    }).run();

    expect(result.status).toBe("succeeded");
    expect(result.archive).toBeUndefined();
    expect(result.checksumPath).toBeUndefined();
    expect(await readdir(path.join(fixture.reports, result.runDirectory, "artifacts"))).toEqual([]);
    expect(await readFile(path.join(fixture.workspace, "package.json"), "utf8")).toBe(
      packageBefore,
    );
    expect(result.releaseNotesPath).toBeDefined();
  });

  it("awaits trace preflight before a dry-run repair mutation", async () => {
    const fixture = await createFixture();
    await rm(path.join(fixture.workspace, "README.md"));
    const model = new MockModelClient({
      responses: [
        {
          kind: "tool_call",
          callId: "create-readme",
          tool: "create_file",
          input: { path: "README.md", content: "# Proposed fixture\n" },
        },
        {
          kind: "complete",
          summary: "Proposed the missing release readme.",
          evidence: ["README.md proposed"],
          findings: [],
          changedFiles: ["README.md"],
        },
      ],
    });

    const result = await new ReleaseEngineerWorkflow({
      action: "prepare",
      mode: "dry-run",
      workspace: fixture.workspace,
      reportsRoot: fixture.reports,
      policies,
      repair: true,
      modelClient: model,
      requestedModel: "mock/coder",
    }).run();
    expect(result.status).toBe("succeeded");
    expect(result.repairs).toHaveLength(1);
    await expect(readFile(path.join(fixture.workspace, "README.md"), "utf8")).rejects.toThrow();

    const events = (
      await readFile(path.join(fixture.reports, result.runDirectory, "trace.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; status: string });
    const preflightIndex = events.findIndex(
      (event) => event.type === "mutation_preflight" && event.status === "ready",
    );
    const completedToolIndex = events.findIndex(
      (event) => event.type === "tool" && event.status === "completed",
    );
    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(completedToolIndex).toBeGreaterThan(preflightIndex);
    const journalText = await readFile(
      path.join(fixture.reports, result.runDirectory, "mutation-journal.json"),
      "utf8",
    );
    const journal = JSON.parse(journalText) as {
      version: number;
      mutations: Array<{
        callId: string;
        tool: string;
        fingerprint: string;
        path: string;
        beforeSha256: string | null;
        afterSha256: string;
        dryRun: boolean;
      }>;
    };
    expect(journal.version).toBe(1);
    expect(journal.mutations).toEqual([
      {
        callId: "release-repairer:create-readme",
        tool: "create_file",
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) as string,
        path: "README.md",
        beforeSha256: null,
        afterSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) as string,
        dryRun: true,
      },
    ]);
    expect(journalText).not.toContain("# Proposed fixture");
  });

  it("rejects junction traversal during deterministic checks", async () => {
    const fixture = await createFixture();
    const outside = path.join(fixture.root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "outside\n");
    try {
      await symlink(outside, path.join(fixture.workspace, "linked"), "junction");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EPERM"
      ) {
        return;
      }
      throw error;
    }

    const result = await new ReleaseEngineerWorkflow({
      action: "check",
      mode: "dry-run",
      workspace: fixture.workspace,
      reportsRoot: fixture.reports,
      policies,
      repair: false,
    }).run();
    expect(result.status).toBe("failed");
    expect(result.checks.findings).toContainEqual(
      expect.objectContaining({ code: "SYMLINK_FORBIDDEN", path: "linked" }),
    );
  });
});
