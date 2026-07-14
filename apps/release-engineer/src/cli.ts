#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createLocalModelClient, type LocalModelClient } from "@local-agent-lab/local-model-client";
import { sanitizedError } from "@local-agent-lab/tracing";

import { loadLaboratoryEnvironment, loadReleasePolicies } from "./config.js";
import { ReleaseEngineerError } from "./errors.js";
import { ReleaseEngineerWorkflow } from "./ReleaseEngineerWorkflow.js";
import {
  ReleaseActionSchema,
  ReleaseModeSchema,
  type ReleaseAction,
  type ReleaseMode,
  type ReleaseWorkflowResult,
} from "./types.js";

export const HELP_TEXT = `Nolan Young Local Agent Laboratory — Release Engineer

Usage:
  local-release-engineer <check|prepare|package|release> --workspace <path> [options]

Actions:
  check      Run authoritative deterministic validation; never uses a model
  prepare    Validate and optionally run bounded repair passes
  package    Require passing checks, then plan or create and inspect a ZIP
  release    Validate/optionally repair, package, checksum, inspect, and write notes

Options:
  --workspace <path>             Target workspace (required)
  --mode <dry-run|apply>         Canonical mode (default: dry-run)
  --dry-run                     Alias for --mode dry-run
  --repair                      Allow repair for prepare/release only
  --task <text>                 Operator repair task
  --max-repair-passes <0..3>    Bounded workflow repair passes (default: 3)
  --provider <lmstudio|mock>     Explicit repair provider (default: lmstudio)
  --model <exact-key>            Exact LM Studio model key
  --base-url <localhost-url>     LM Studio HTTP control-plane URL
  --reports-root <path>          Trusted report root outside the target workspace
  --check-policy <path>          Explicit operator-selected check policy
  --package-policy <path>        Explicit operator-selected package policy
  --json                         Print the sanitized result as JSON
  --help                         Show help

Exit codes:
  0 success/help, 1 failed workflow, 2 usage/configuration,
  3 model/infrastructure, 130 interruption

Dry-run emits no ZIP or checksum. No action publishes, tags, commits, pushes,
or creates a hosted release. Only the laboratory's optional .env is loaded.
`;

interface ParsedArguments {
  readonly action?: string;
  readonly values: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
}

const VALUE_FLAGS = new Set([
  "--workspace",
  "--mode",
  "--task",
  "--max-repair-passes",
  "--provider",
  "--model",
  "--base-url",
  "--reports-root",
  "--check-policy",
  "--package-policy",
]);
const SWITCH_FLAGS = new Set(["--dry-run", "--repair", "--json", "--help"]);

function parseArguments(argv: readonly string[]): ParsedArguments {
  let action: string | undefined;
  const values = new Map<string, string>();
  const switches = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("--")) {
      if (action !== undefined) {
        throw new ReleaseEngineerError(
          "UNEXPECTED_POSITIONAL_ARGUMENT",
          "Only one action may be supplied.",
          "configuration",
        );
      }
      action = argument;
      continue;
    }
    if (SWITCH_FLAGS.has(argument)) {
      if (switches.has(argument)) {
        throw new ReleaseEngineerError(
          "DUPLICATE_OPTION",
          `Option ${argument} was supplied more than once.`,
          "configuration",
        );
      }
      switches.add(argument);
      continue;
    }
    if (!VALUE_FLAGS.has(argument)) {
      throw new ReleaseEngineerError(
        "UNKNOWN_OPTION",
        `Unknown option: ${argument}`,
        "configuration",
      );
    }
    if (values.has(argument)) {
      throw new ReleaseEngineerError(
        "DUPLICATE_OPTION",
        `Option ${argument} was supplied more than once.`,
        "configuration",
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ReleaseEngineerError(
        "OPTION_VALUE_MISSING",
        `Option ${argument} requires a value.`,
        "configuration",
      );
    }
    values.set(argument, value);
    index += 1;
  }
  return { ...(action === undefined ? {} : { action }), values, switches };
}

function finiteRepairPasses(raw: string | undefined): number {
  if (raw === undefined) return 3;
  if (!/^[0-3]$/u.test(raw)) {
    throw new ReleaseEngineerError(
      "INVALID_REPAIR_LIMIT",
      "--max-repair-passes must be an integer from 0 through 3.",
      "configuration",
    );
  }
  return Number(raw);
}

function selectedAction(raw: string | undefined): ReleaseAction {
  const parsed = ReleaseActionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReleaseEngineerError(
      "ACTION_REQUIRED",
      "Select exactly one action: check, prepare, package, or release.",
      "configuration",
    );
  }
  return parsed.data;
}

function selectedMode(arguments_: ParsedArguments): ReleaseMode {
  const explicitMode = arguments_.values.get("--mode");
  if (arguments_.switches.has("--dry-run") && explicitMode === undefined) {
    return "dry-run";
  }
  const configuredMode = explicitMode ?? process.env["LOCAL_AGENT_MODE"] ?? "dry-run";
  const parsed = ReleaseModeSchema.safeParse(configuredMode);
  if (!parsed.success) {
    throw new ReleaseEngineerError(
      "MODE_INVALID",
      "Mode must be dry-run or apply.",
      "configuration",
    );
  }
  if (arguments_.switches.has("--dry-run") && parsed.data !== "dry-run") {
    throw new ReleaseEngineerError(
      "MODE_CONFLICT",
      "--dry-run conflicts with the selected apply mode.",
      "configuration",
    );
  }
  return arguments_.switches.has("--dry-run") ? "dry-run" : parsed.data;
}

function createRepairModel(
  provider: string,
  requestedModel: string,
  baseUrl: string | undefined,
): LocalModelClient {
  if (provider === "mock") {
    const completion = {
      kind: "complete",
      summary: "No deterministic mock repair was scripted.",
      evidence: [],
      findings: [],
      changedFiles: [],
    };
    return createLocalModelClient({
      provider: "mock",
      mock: { responses: [completion, completion, completion] },
    });
  }
  if (provider !== "lmstudio") {
    throw new ReleaseEngineerError(
      "PROVIDER_INVALID",
      "Provider must be lmstudio or mock.",
      "configuration",
    );
  }
  return createLocalModelClient({
    provider: "lmstudio",
    config: {
      requestedModel,
      ...(baseUrl === undefined ? {} : { baseUrl }),
    },
  });
}

function printHuman(result: ReleaseWorkflowResult, reportsRoot: string): void {
  const icon = result.status === "succeeded" ? "PASS" : "FAIL";
  process.stdout.write(
    [
      `${icon} ${result.action} (${result.mode})`,
      result.summary,
      `Checks: ${result.checks.passed ? "passed" : "failed"}`,
      `Findings: ${result.checks.findings.length}`,
      `Run directory: ${path.join(reportsRoot, result.runDirectory)}`,
      ...(result.archive === undefined
        ? []
        : [
            `Archive: ${path.join(reportsRoot, result.runDirectory, result.archive.archivePath)} (${result.archive.archiveBytes} bytes)`,
          ]),
      ...(result.checksum === undefined ? [] : [`SHA-256: ${result.checksum}`]),
      "",
    ].join("\n"),
  );
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const abortController = new AbortController();
  const interrupt = (): void => abortController.abort();
  process.once("SIGINT", interrupt);
  try {
    const arguments_ = parseArguments(argv);
    if (arguments_.switches.has("--help")) {
      process.stdout.write(HELP_TEXT);
      return 0;
    }
    const action = selectedAction(arguments_.action);
    const workspace = arguments_.values.get("--workspace");
    if (workspace === undefined || workspace.trim().length === 0) {
      throw new ReleaseEngineerError(
        "WORKSPACE_REQUIRED",
        "--workspace is required.",
        "configuration",
      );
    }
    const repair = arguments_.switches.has("--repair");
    if (repair && action !== "prepare" && action !== "release") {
      throw new ReleaseEngineerError(
        "REPAIR_NOT_ALLOWED",
        "--repair is available only for prepare and release.",
        "configuration",
      );
    }

    const locations = await loadLaboratoryEnvironment();
    const mode = selectedMode(arguments_);
    const requestedModel =
      arguments_.values.get("--model") ??
      process.env["LM_STUDIO_MODEL"] ??
      "qwen/qwen2.5-coder-14b";
    const provider =
      arguments_.values.get("--provider") ??
      process.env["LOCAL_AGENT_MODEL_PROVIDER"] ??
      "lmstudio";
    const reportsRoot = path.resolve(
      arguments_.values.get("--reports-root") ??
        process.env["REPORTS_DIRECTORY"] ??
        process.env["LOCAL_AGENT_REPORTS_ROOT"] ??
        path.join(locations.laboratoryRoot, "reports", "runs"),
    );
    const policies = await loadReleasePolicies({
      ...(arguments_.values.get("--check-policy") === undefined
        ? {}
        : { checkPolicyPath: arguments_.values.get("--check-policy") as string }),
      ...(arguments_.values.get("--package-policy") === undefined
        ? {}
        : { packagePolicyPath: arguments_.values.get("--package-policy") as string }),
    });
    const modelClient = repair
      ? createRepairModel(provider, requestedModel, arguments_.values.get("--base-url"))
      : undefined;

    const result = await new ReleaseEngineerWorkflow({
      action,
      mode,
      workspace,
      reportsRoot,
      policies,
      repair,
      maximumRepairPasses: finiteRepairPasses(arguments_.values.get("--max-repair-passes")),
      operatorTask:
        arguments_.values.get("--task") ??
        "Repair the deterministic release-readiness findings without altering policy.",
      requestedModel,
      signal: abortController.signal,
      ...(modelClient === undefined ? {} : { modelClient }),
    }).run();
    if (arguments_.switches.has("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printHuman(result, reportsRoot);
    }
    return result.status === "succeeded" ? 0 : 1;
  } catch (error) {
    const interrupted = abortController.signal.aborted;
    const exitCode = interrupted
      ? 130
      : error instanceof ReleaseEngineerError
        ? error.exitCode
        : error instanceof Error && error.name === "ModelClientError"
          ? 3
          : error instanceof Error && error.name === "WorkspaceSecurityError"
            ? 2
            : 3;
    const safe = sanitizedError(error);
    process.stderr.write(
      `${interrupted ? "INTERRUPTED" : "ERROR"} ${safe.code ?? "UNEXPECTED"}: ${safe.message}\n`,
    );
    return exitCode;
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  process.exitCode = await main();
}
