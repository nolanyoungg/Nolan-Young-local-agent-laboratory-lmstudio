import { realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type { TrustedCommandDefinitionInput } from "./CommandAllowlist.js";
import { ProcessToolError } from "./errors.js";

export interface NpmCommandOptions {
  readonly id: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly inheritEnvironment?: readonly string[];
}

export async function createNpmCommandDefinition(
  options: NpmCommandOptions,
  npmExecPath: string | undefined = process.env["npm_execpath"],
): Promise<TrustedCommandDefinitionInput> {
  if (npmExecPath === undefined || !isAbsolute(npmExecPath)) {
    throw new ProcessToolError(
      "INVALID_NPM_EXEC_PATH",
      "npm_execpath must be an absolute path to npm-cli.js.",
    );
  }

  let resolved: string;
  try {
    resolved = await realpath(npmExecPath);
    const metadata = await stat(resolved);
    if (!metadata.isFile()) {
      throw new Error("not a file");
    }
  } catch (error) {
    throw new ProcessToolError(
      "INVALID_NPM_EXEC_PATH",
      "npm_execpath does not resolve to a regular file.",
      { cause: error },
    );
  }

  const name = basename(resolved).toLowerCase();
  if (name !== "npm-cli.js" || extname(name) !== ".js") {
    throw new ProcessToolError("INVALID_NPM_EXEC_PATH", "npm_execpath must resolve to npm-cli.js.");
  }

  return {
    id: options.id,
    executable: process.execPath,
    args: [resolved, ...options.args],
    cwd: options.cwd,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    environment: { ...options.environment },
    inheritEnvironment: [...(options.inheritEnvironment ?? [])],
  };
}
