import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseDotEnv } from "dotenv";

import {
  CodeEditorModeSchema,
  EditPolicySchema,
  PermissionsSchema,
  type CodeEditorMode,
  type EditPolicy,
  type RolePermissions,
} from "./types.js";

const DEFAULT_MODEL = "qwen/qwen2.5-coder-14b";
const MOCK_MODEL = "mock/coder";

export class CodeEditorUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CodeEditorUsageError";
  }
}

export interface ParsedCliArguments {
  readonly help: boolean;
  readonly workspace?: string;
  readonly task?: string;
  readonly mode?: CodeEditorMode;
  readonly dryRunAlias: boolean;
  readonly mock: boolean;
  readonly model?: string;
  readonly reportsRoot?: string;
  readonly baseUrl?: string;
}

export interface CodeEditorConfig {
  readonly laboratoryRoot: string;
  readonly applicationRoot: string;
  readonly workspace: string;
  readonly task: string;
  readonly mode: CodeEditorMode;
  readonly mock: boolean;
  readonly requestedModel: string;
  readonly reportsRoot: string;
  readonly lockRoot: string;
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
  readonly temperature: number;
  readonly environment: NodeJS.ProcessEnv;
  readonly permissions: RolePermissions;
  readonly editPolicy: EditPolicy;
  readonly prompts: Readonly<{
    planner: string;
    editor: string;
    reviewer: string;
  }>;
}

export interface LoadConfigurationOptions {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

const VALUE_FLAGS = new Set(["workspace", "task", "mode", "model", "reports-root", "base-url"]);
const BOOLEAN_FLAGS = new Set(["help", "dry-run", "mock"]);

export function parseCliArguments(argv: readonly string[]): ParsedCliArguments {
  const values = new Map<string, string>();
  const booleans = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || !argument.startsWith("--")) {
      throw new CodeEditorUsageError(`Unexpected positional argument: ${argument ?? ""}`);
    }
    const body = argument.slice(2);
    const separator = body.indexOf("=");
    const name = separator === -1 ? body : body.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : body.slice(separator + 1);

    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== undefined) {
        throw new CodeEditorUsageError(`--${name} does not accept a value`);
      }
      if (booleans.has(name)) {
        throw new CodeEditorUsageError(`--${name} was provided more than once`);
      }
      booleans.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new CodeEditorUsageError(`Unknown option: --${name}`);
    }
    if (values.has(name)) {
      throw new CodeEditorUsageError(`--${name} was provided more than once`);
    }
    const nextValue = inlineValue ?? argv[index + 1];
    if (nextValue === undefined || nextValue.length === 0 || nextValue.startsWith("--")) {
      throw new CodeEditorUsageError(`--${name} requires a value`);
    }
    values.set(name, nextValue);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  const parsedMode = values.get("mode");
  const modeResult =
    parsedMode === undefined ? undefined : CodeEditorModeSchema.safeParse(parsedMode);
  if (modeResult !== undefined && !modeResult.success) {
    throw new CodeEditorUsageError("--mode must be one of: plan-only, dry-run, apply");
  }
  if (booleans.has("dry-run") && modeResult?.data !== undefined && modeResult.data !== "dry-run") {
    throw new CodeEditorUsageError("--dry-run conflicts with a non-dry-run --mode value");
  }

  const workspace = values.get("workspace");
  const task = values.get("task");
  const model = values.get("model");
  const reportsRoot = values.get("reports-root");
  const baseUrl = values.get("base-url");
  return {
    help: booleans.has("help"),
    ...(workspace === undefined ? {} : { workspace }),
    ...(task === undefined ? {} : { task }),
    ...(modeResult?.data === undefined ? {} : { mode: modeResult.data }),
    dryRunAlias: booleans.has("dry-run"),
    mock: booleans.has("mock"),
    ...(model === undefined ? {} : { model }),
    ...(reportsRoot === undefined ? {} : { reportsRoot }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
}

export async function loadCodeEditorConfig(
  arguments_: ParsedCliArguments,
  options: LoadConfigurationOptions = {},
): Promise<CodeEditorConfig> {
  if (arguments_.help) {
    throw new CodeEditorUsageError("Help arguments do not produce a runnable configuration");
  }
  const workspaceArgument = requiredValue(arguments_.workspace, "--workspace");
  const task = requiredValue(arguments_.task, "--task");
  if (task.length > 100_000) {
    throw new CodeEditorUsageError("--task exceeds 100,000 characters");
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const applicationRoot = await findPackageRoot(
    path.dirname(fileURLToPath(import.meta.url)),
    "@local-agent-lab/code-editor",
  );
  const laboratoryRoot = path.resolve(applicationRoot, "../..");
  const fileEnvironment = await readOptionalLaboratoryEnvironment(laboratoryRoot);
  const environment = mergeEnvironment(fileEnvironment, options.environment ?? process.env);
  if (arguments_.baseUrl !== undefined) {
    environment["LM_STUDIO_BASE_URL"] = arguments_.baseUrl;
  }

  const mode = arguments_.dryRunAlias ? "dry-run" : (arguments_.mode ?? "plan-only");
  const requestedModel =
    arguments_.model ??
    environment["LM_STUDIO_MODEL"] ??
    (arguments_.mock ? MOCK_MODEL : DEFAULT_MODEL);
  const reportsRoot = path.resolve(
    cwd,
    arguments_.reportsRoot ??
      environment["REPORTS_DIRECTORY"] ??
      environment["LOCAL_AGENT_REPORTS_ROOT"] ??
      path.join(laboratoryRoot, "reports", "runs"),
  );
  const permissions = PermissionsSchema.parse(
    await readJson(path.join(applicationRoot, "config", "permissions.json")),
  );
  const editPolicy = EditPolicySchema.parse(
    await readJson(path.join(applicationRoot, "config", "edit-policy.json")),
  );

  return {
    laboratoryRoot,
    applicationRoot,
    workspace: path.resolve(cwd, workspaceArgument),
    task,
    mode,
    mock: arguments_.mock,
    requestedModel,
    reportsRoot,
    lockRoot: path.join(reportsRoot, ".locks"),
    contextTokens: parseFiniteEnvironmentNumber(
      environment,
      "MODEL_CONTEXT_TOKENS",
      32_768,
      1_024,
      1_048_576,
    ),
    maxOutputTokens: parseFiniteEnvironmentNumber(
      environment,
      "MODEL_MAX_OUTPUT_TOKENS",
      4_096,
      1,
      32_768,
    ),
    temperature: parseFiniteEnvironmentNumber(environment, "MODEL_TEMPERATURE", 0.1, 0, 2),
    environment,
    permissions,
    editPolicy,
    prompts: {
      planner: await readFile(path.join(applicationRoot, "prompts", "planner.system.md"), "utf8"),
      editor: await readFile(path.join(applicationRoot, "prompts", "editor.system.md"), "utf8"),
      reviewer: await readFile(path.join(applicationRoot, "prompts", "reviewer.system.md"), "utf8"),
    },
  };
}

async function findPackageRoot(start: string, packageName: string): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    try {
      const packageJson = JSON.parse(
        await readFile(path.join(current, "package.json"), "utf8"),
      ) as { readonly name?: unknown };
      if (packageJson.name === packageName) {
        return current;
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new CodeEditorUsageError(`Could not locate package ${packageName}`);
    }
    current = parent;
  }
}

async function readOptionalLaboratoryEnvironment(
  laboratoryRoot: string,
): Promise<Record<string, string>> {
  try {
    return parseDotEnv(await readFile(path.join(laboratoryRoot, ".env"), "utf8"));
  } catch (error) {
    if (isMissingFile(error)) {
      return {};
    }
    throw error;
  }
}

function mergeEnvironment(
  lowerPrecedence: Readonly<Record<string, string>>,
  higherPrecedence: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...lowerPrecedence };
  for (const [name, value] of Object.entries(higherPrecedence)) {
    if (value !== undefined) {
      merged[name] = value;
    }
  }
  return merged;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

function requiredValue(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new CodeEditorUsageError(`${name} is required`);
  }
  return value;
}

function parseFiniteEnvironmentNumber(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new CodeEditorUsageError(
      `${name} must be a finite number from ${minimum} through ${maximum}`,
    );
  }
  return value;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export const CODE_EDITOR_HELP = `Nolan Young Local Agent Laboratory - Code Editor

Usage:
  npm run code-editor -- --workspace <path> --task <description> [options]

Required:
  --workspace <path>       Target workspace to confine and lock
  --task <description>     Requested code change

Options:
  --mode <mode>            plan-only (default), dry-run, or apply
  --dry-run                Alias for --mode dry-run
  --mock                   Use the explicit deterministic mock model
  --model <id>             Exact LM Studio model key or selected variant ID
  --base-url <url>         Loopback LM Studio HTTP control-plane URL
  --reports-root <path>    Trusted report root outside the target workspace
  --help                   Show this help

Exit codes: 0 success/help, 1 workflow failure, 2 usage/configuration,
3 model/infrastructure failure, 130 interruption.
`;
