import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectories = [
  "apps/code-editor",
  "apps/build-assistant",
  "apps/release-engineer",
  "packages/shared-types",
  "packages/workspace-security",
  "packages/filesystem-tools",
  "packages/process-tools",
  "packages/tracing",
  "packages/local-model-client",
  "packages/agent-runtime",
] as const;

function isContained(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

async function assertGeneratedTarget(root: string, target: string): Promise<void> {
  const resolved = resolve(target);
  if (!isContained(root, resolved)) {
    throw new Error(`Refusing to clean unsafe path: ${resolved}`);
  }

  try {
    const metadata = await lstat(resolved);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing to clean a generated-root symlink or junction: ${resolved}`);
    }
    const canonical = await realpath(resolved);
    if (!isContained(root, canonical)) {
      throw new Error(`Refusing to clean a generated root outside the repository: ${resolved}`);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      const canonicalParent = await realpath(dirname(resolved));
      if (!isContained(root, canonicalParent) && canonicalParent !== root) {
        throw new Error(`Refusing to clean through an unsafe parent: ${resolved}`);
      }
      return;
    }
    throw error;
  }
}

async function removeTarget(root: string, target: string): Promise<void> {
  await assertGeneratedTarget(root, target);
  await rm(target, { force: true, recursive: true });
}

async function main(): Promise<void> {
  const canonicalRoot = await realpath(repositoryRoot);
  const retainedRoots = [
    resolve(canonicalRoot, "reports", "runs"),
    resolve(canonicalRoot, "workspaces"),
  ] as const;
  const generatedRoots = [
    resolve(canonicalRoot, "dist-scripts"),
    resolve(canonicalRoot, "coverage"),
    ...workspaceDirectories.map((directory) => resolve(canonicalRoot, directory, "dist")),
    ...retainedRoots,
  ];

  for (const target of generatedRoots) await removeTarget(canonicalRoot, target);
  for (const target of retainedRoots) {
    await mkdir(target, { recursive: true });
    await writeFile(resolve(target, ".gitkeep"), "", { encoding: "utf8", flag: "wx" });
  }
  console.log("Removed generated builds, coverage, reports, and workspace contents.");
}

await main();
