import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { FilesystemToolError } from "./errors.js";
import type { ToolDependencies } from "./types.js";

const MAX_OUTPUT_BYTES = 131_072;
const TIMEOUT_MS = 120_000;
const AllowedNpmScriptSchema = z.enum(["build", "lint", "test", "typecheck", "package"]);

export const RunValidationInputSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("php_lint"), paths: z.array(z.string().min(1)).min(1).max(100) })
    .strict(),
  z.object({ kind: z.literal("npm_script"), script: AllowedNpmScriptSchema }).strict(),
]);

export type ValidationResult =
  | Readonly<{
      kind: "php_lint";
      status: "passed" | "failed" | "blocked";
      command: string;
      paths: readonly string[];
      output: string;
      exitCode: number | null;
    }>
  | Readonly<{
      kind: "npm_script";
      status: "passed" | "failed" | "blocked";
      command: string;
      script: z.infer<typeof AllowedNpmScriptSchema>;
      output: string;
      exitCode: number | null;
    }>;

export type ValidationCommandRunner = (
  command: string,
  args: readonly string[],
  cwdPath: string,
) => Promise<{ exitCode: number | null; output: string }>;

export class RunValidationTool {
  readonly #guard: ToolDependencies["workspaceGuard"];
  readonly #dryRun: boolean;
  readonly #run: ValidationCommandRunner;
  readonly #workspaceRoot: string;

  public constructor(
    dependencies: ToolDependencies,
    workspaceRoot: string,
    commandRunner: ValidationCommandRunner = run,
  ) {
    this.#guard = dependencies.workspaceGuard;
    this.#dryRun = dependencies.dryRun ?? false;
    this.#workspaceRoot = workspaceRoot;
    this.#run = commandRunner;
  }

  public async execute(input: unknown): Promise<ValidationResult> {
    const parsed = RunValidationInputSchema.safeParse(input);
    if (!parsed.success)
      throw new FilesystemToolError("INVALID_INPUT", "Invalid validation tool input.");
    if (parsed.data.kind === "php_lint") return this.#phpLint(parsed.data.paths);
    if (this.#dryRun)
      throw new FilesystemToolError(
        "VALIDATION_DENIED",
        "npm-script validation requires --apply because builds may write generated assets.",
      );
    return this.#npmScript(parsed.data.script);
  }

  async #phpLint(paths: readonly string[]): Promise<ValidationResult> {
    const guarded = await Promise.all(
      paths.map(async (path) => {
        if (!path.toLowerCase().endsWith(".php"))
          throw new FilesystemToolError("VALIDATION_DENIED", "php_lint accepts only .php files.");
        return this.#guard.resolveForRead(path);
      }),
    );
    const command = `php -l ${guarded.map((entry) => entry.relativePath).join(" ")}`;
    try {
      const result = await this.#run(
        "php",
        ["-l", ...guarded.map((entry) => entry.absolutePath)],
        this.#workspaceRoot,
      );
      return {
        kind: "php_lint",
        status: result.exitCode === 0 ? "passed" : "failed",
        command,
        paths: guarded.map((entry) => entry.relativePath),
        output: result.output,
        exitCode: result.exitCode,
      };
    } catch (error) {
      if (isMissingExecutable(error)) {
        return {
          kind: "php_lint",
          status: "blocked",
          command,
          paths: guarded.map((entry) => entry.relativePath),
          output: "PHP executable is unavailable.",
          exitCode: null,
        };
      }
      throw error;
    }
  }

  async #npmScript(script: z.infer<typeof AllowedNpmScriptSchema>): Promise<ValidationResult> {
    const manifest = await this.#guard.resolveForRead("package.json");
    let packageJson: unknown;
    try {
      packageJson = JSON.parse(await readFile(manifest.absolutePath, "utf8")) as unknown;
    } catch {
      throw new FilesystemToolError(
        "VALIDATION_DENIED",
        "The workspace package.json is missing or invalid JSON.",
      );
    }
    const scripts =
      typeof packageJson === "object" && packageJson !== null && !Array.isArray(packageJson)
        ? (packageJson as Record<string, unknown>)["scripts"]
        : undefined;
    if (
      typeof scripts !== "object" ||
      scripts === null ||
      Array.isArray(scripts) ||
      typeof (scripts as Record<string, unknown>)[script] !== "string"
    )
      throw new FilesystemToolError(
        "VALIDATION_DENIED",
        `package.json does not declare npm script ${script}.`,
      );
    const command = `npm run ${script}`;
    const executable = process.platform === "win32" ? "npm.cmd" : "npm";
    let result: { exitCode: number | null; output: string };
    try {
      result = await this.#run(executable, ["run", script], this.#workspaceRoot);
    } catch (error) {
      if (isMissingExecutable(error))
        return {
          kind: "npm_script",
          status: "blocked",
          command,
          script,
          output: "npm executable is unavailable.",
          exitCode: null,
        };
      throw error;
    }
    return {
      kind: "npm_script",
      status: result.exitCode === 0 ? "passed" : "failed",
      command,
      script,
      output: result.output,
      exitCode: result.exitCode,
    };
  }
}

async function run(
  command: string,
  args: readonly string[],
  cwdPath: string | undefined,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: cwdPath, shell: false, windowsHide: true });
    let output = "";
    const append = (chunk: Buffer) => {
      if (Buffer.byteLength(output, "utf8") >= MAX_OUTPUT_BYTES) return;
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES)
        output = output.slice(0, MAX_OUTPUT_BYTES);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timeout = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, output: output || `${basename(command)} produced no output.` });
    });
  });
}

function isMissingExecutable(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
