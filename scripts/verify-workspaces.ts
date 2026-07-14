import { access, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredApps = ["build-assistant", "code-editor", "release-engineer"] as const;
const requiredPackages = [
  "agent-runtime",
  "filesystem-tools",
  "local-model-client",
  "process-tools",
  "shared-types",
  "tracing",
  "workspace-security",
] as const;

async function assertDirectories(
  parent: string,
  expected: readonly string[],
  exact: boolean,
): Promise<void> {
  const entries = (await readdir(parent, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const expectedSorted = [...expected].sort();
  const missing = expectedSorted.filter((name) => !entries.includes(name));
  const extras = exact ? entries.filter((name) => !expectedSorted.includes(name)) : [];
  if (missing.length > 0 || extras.length > 0) {
    throw new Error(
      `Workspace verification failed for ${parent}: missing=${missing.join(",") || "none"}; extra=${extras.join(",") || "none"}`,
    );
  }
}

async function main(): Promise<void> {
  const canonicalRoot = await realpath(repositoryRoot);
  await access(resolve(canonicalRoot, "package.json"), constants.R_OK);
  await assertDirectories(resolve(canonicalRoot, "apps"), requiredApps, true);
  await assertDirectories(resolve(canonicalRoot, "packages"), requiredPackages, true);
  await assertDirectories(
    resolve(canonicalRoot, "examples"),
    ["broken-typescript-project", "sample-node-project", "sample-release-project"],
    true,
  );
  console.log(`Workspace structure verified at ${canonicalRoot}`);
}

await main();
