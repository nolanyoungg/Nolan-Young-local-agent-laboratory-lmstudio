#!/usr/bin/env node
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { sanitizedError } from "@local-agent-lab/tracing";

import { loadLaboratoryEnvironment, type ApplicationLocations } from "./config.js";
import { BuildAssistantError } from "./errors.js";
import { runBuildAssistant, type BuildAssistantWorkflowOptions } from "./BuildAssistantWorkflow.js";
import { BuildModeSchema, type BuildAssistantResult, type BuildMode } from "./types.js";

const HELP = `Nolan Young Local Agent Laboratory — Build Assistant

Usage:
  local-build-assistant --workspace <path> --command <id> --mode <dry-run|apply> [options]
  npm run build-assistant -- --workspace <path> --command <id> --mode <dry-run|apply> [options]

Required:
  --workspace <path>       Target workspace to confine and lock
  --command <id>           Symbolic ID from the trusted command map
  --mode <mode>            dry-run or apply

Options:
  --commands-file <path>   Explicit operator-selected trusted command map
  --reports-root <path>    Trusted report root outside the target workspace
  --model <key>            Exact LM Studio model key
  --mock                   Use the explicit deterministic local mock
  --json                   Print a machine-readable summary
  -h, --help               Show this help

Exit codes:
  0   command verified or help
  1   unresolved build or unverified dry-run proposal
  2   usage or trusted configuration error
  3   model or process infrastructure failure
  130 interrupted
`;

interface ParsedArguments {
  readonly help: boolean;
  readonly workspace?: string;
  readonly commandId?: string;
  readonly mode?: BuildMode;
  readonly commandsFile?: string;
  readonly reportsRoot?: string;
  readonly model?: string;
  readonly mock: boolean;
  readonly json: boolean;
}

export interface CliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

const DEFAULT_IO: CliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

function valueAfter(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--") || value.length === 0) {
    throw new BuildAssistantError(
      "MISSING_OPTION_VALUE",
      `${flag} requires a value.`,
      "configuration",
    );
  }
  return value;
}

export function parseBuildAssistantArguments(argv: readonly string[]): ParsedArguments {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true, mock: false, json: false };
  }
  const values = new Map<string, string>();
  let mock = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mock" || argument === "--json") {
      if ((argument === "--mock" && mock) || (argument === "--json" && json)) {
        throw new BuildAssistantError(
          "DUPLICATE_OPTION",
          `${argument} may be supplied only once.`,
          "configuration",
        );
      }
      if (argument === "--mock") mock = true;
      else json = true;
      continue;
    }
    if (
      argument !== "--workspace" &&
      argument !== "--command" &&
      argument !== "--mode" &&
      argument !== "--commands-file" &&
      argument !== "--reports-root" &&
      argument !== "--model"
    ) {
      throw new BuildAssistantError(
        "UNKNOWN_OPTION",
        `Unknown option: ${argument ?? "<empty>"}.`,
        "configuration",
      );
    }
    if (values.has(argument)) {
      throw new BuildAssistantError(
        "DUPLICATE_OPTION",
        `${argument} may be supplied only once.`,
        "configuration",
      );
    }
    values.set(argument, valueAfter(argv, index, argument));
    index += 1;
  }

  const workspace = values.get("--workspace");
  const commandId = values.get("--command");
  const rawMode = values.get("--mode");
  if (workspace === undefined || commandId === undefined || rawMode === undefined) {
    throw new BuildAssistantError(
      "MISSING_REQUIRED_OPTION",
      "--workspace, --command, and --mode are required.",
      "configuration",
    );
  }
  const mode = BuildModeSchema.safeParse(rawMode);
  if (!mode.success) {
    throw new BuildAssistantError(
      "INVALID_MODE",
      "--mode must be dry-run or apply.",
      "configuration",
    );
  }
  const commandsFile = values.get("--commands-file");
  const reportsRoot = values.get("--reports-root");
  const model = values.get("--model");
  return {
    help: false,
    workspace,
    commandId,
    mode: mode.data,
    ...(commandsFile === undefined ? {} : { commandsFile }),
    ...(reportsRoot === undefined ? {} : { reportsRoot }),
    ...(model === undefined ? {} : { model }),
    mock,
    json,
  };
}

function printableResult(result: BuildAssistantResult): Readonly<Record<string, unknown>> {
  const workspaceIdentity =
    process.platform === "win32" ? result.workspace.toLowerCase() : result.workspace;
  return {
    status: result.status,
    finalStatus: result.finalStatus,
    summary: result.summary,
    mode: result.mode,
    commandId: result.commandId,
    runId: result.runId,
    runDirectory: path.basename(result.runDirectory),
    workspace: {
      name: path.basename(result.workspace),
      identitySha256: createHash("sha256").update(workspaceIdentity).digest("hex"),
    },
    watcher: result.watcher,
    initialStatus: result.initial.status,
    repairPasses: result.passes.length,
    changedFiles: result.changedFiles.map((change) => ({
      path: change.path,
      operation: change.operation,
      beforeSha256: change.beforeSha256,
      afterSha256: change.afterSha256,
      dryRun: change.dryRun,
    })),
  };
}

function workflowOptions(
  parsed: ParsedArguments,
  locations: ApplicationLocations,
  signal: AbortSignal | undefined,
): BuildAssistantWorkflowOptions {
  if (
    parsed.workspace === undefined ||
    parsed.commandId === undefined ||
    parsed.mode === undefined
  ) {
    throw new BuildAssistantError(
      "ARGUMENT_STATE_INVALID",
      "Required arguments were not parsed.",
      "configuration",
    );
  }
  const reportsRoot =
    parsed.reportsRoot ??
    process.env["REPORTS_DIRECTORY"] ??
    process.env["LOCAL_AGENT_LAB_REPORTS_ROOT"] ??
    path.join(locations.laboratoryRoot, "reports", "runs");
  const commandsFile = parsed.commandsFile ?? process.env["BUILD_ASSISTANT_COMMANDS_FILE"];
  const model = parsed.model ?? process.env["LM_STUDIO_MODEL"];
  return {
    workspace: parsed.workspace,
    commandId: parsed.commandId,
    mode: parsed.mode,
    reportsRoot,
    ...(commandsFile === undefined ? {} : { commandConfigurationPath: commandsFile }),
    ...(model === undefined ? {} : { requestedModel: model }),
    mock: parsed.mock,
    ...(signal === undefined ? {} : { signal }),
  };
}

export async function runBuildAssistantCli(
  argv: readonly string[],
  options: Readonly<{ io?: CliIo; signal?: AbortSignal }> = {},
): Promise<number> {
  const io = options.io ?? DEFAULT_IO;
  try {
    const parsed = parseBuildAssistantArguments(argv);
    if (parsed.help) {
      io.stdout(HELP);
      return 0;
    }
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    if (nodeMajor !== 24) {
      throw new BuildAssistantError(
        "UNSUPPORTED_NODE_VERSION",
        "Build Assistant requires Node 24.x.",
        "configuration",
      );
    }
    const locations = await loadLaboratoryEnvironment();
    const result = await runBuildAssistant(workflowOptions(parsed, locations, options.signal), {
      locations,
    });
    if (parsed.json) {
      io.stdout(`${JSON.stringify(printableResult(result), null, 2)}\n`);
    } else {
      io.stdout(`${result.summary}\nRun directory: ${result.runDirectory}\n`);
    }
    return result.status === "succeeded" ? 0 : 1;
  } catch (error) {
    const safe = sanitizedError(error);
    const exitCode =
      error instanceof BuildAssistantError
        ? error.exitCode
        : options.signal?.aborted === true
          ? 130
          : 3;
    io.stderr(`Build Assistant error [${safe.code ?? safe.name}]: ${safe.message}\n`);
    return exitCode;
  }
}

async function main(): Promise<void> {
  const abortController = new AbortController();
  const interrupt = (): void => abortController.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    process.exitCode = await runBuildAssistantCli(process.argv.slice(2), {
      signal: abortController.signal,
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href ===
    pathToFileURL(path.resolve(fileURLToPath(import.meta.url))).href
) {
  await main();
}
