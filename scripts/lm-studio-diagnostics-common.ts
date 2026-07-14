import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

import type {
  DiagnosticCheck,
  LMStudioDiagnosticSummary,
} from "@local-agent-lab/local-model-client";
import {
  ModelClientError,
  createLMStudioConnectionConfig,
  createLMStudioModelClient,
  redactSensitiveText,
  type LMStudioConnectionConfig,
} from "@local-agent-lab/local-model-client";

const laboratoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotenv({
  path: resolve(laboratoryRoot, ".env"),
  override: false,
  quiet: true,
});

export const CLI_EXIT = {
  success: 0,
  workflowFailure: 1,
  usage: 2,
  infrastructure: 3,
  interrupted: 130,
} as const;

export interface DiagnosticCliOptions {
  readonly help: boolean;
  readonly json: boolean;
  readonly inference: boolean;
  readonly baseUrl?: string;
  readonly model?: string;
}

export class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function parseDiagnosticArgs(
  arguments_: readonly string[],
  options: { readonly supportsInference?: boolean } = {},
): DiagnosticCliOptions {
  let help = false;
  let json = false;
  let inference = false;
  let baseUrl: string | undefined;
  let model: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--inference" && options.supportsInference === true) {
      inference = true;
    } else if (argument === "--base-url") {
      baseUrl = requiredValue(arguments_, ++index, "--base-url");
    } else if (argument === "--model") {
      model = requiredValue(arguments_, ++index, "--model");
    } else {
      throw new CliUsageError(`Unknown argument: ${argument ?? "<missing>"}`);
    }
  }
  return {
    help,
    json,
    inference,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(model === undefined ? {} : { model }),
  };
}

function requiredValue(arguments_: readonly string[], index: number, flag: string): string {
  const value = arguments_[index];
  if (value === undefined || value.startsWith("--") || value.trim() === "") {
    throw new CliUsageError(`${flag} requires a value.`);
  }
  return value;
}

export function configFromCli(options: DiagnosticCliOptions): LMStudioConnectionConfig {
  return createLMStudioConnectionConfig({
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.model === undefined ? {} : { requestedModel: options.model }),
  });
}

export function clientFromCli(options: DiagnosticCliOptions) {
  return createLMStudioModelClient({ config: configFromCli(options) });
}

export function printDiagnosticSummary(summary: LMStudioDiagnosticSummary, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, undefined, 2)}\n`);
    return;
  }
  process.stdout.write(`LM Studio endpoint: ${summary.endpoint}\n`);
  process.stdout.write(`Requested model: ${summary.requestedModel}\n`);
  process.stdout.write(`Inference transport: ${summary.transport}\n`);
  process.stdout.write("LM Link routing is managed by LM Studio.\n\n");
  for (const check of summary.checks) {
    const timing = check.durationMs === undefined ? "" : ` (${check.durationMs} ms)`;
    process.stdout.write(`[${check.status}] ${check.name}${timing}: ${check.message}\n`);
  }
}

export function printSafeCliError(error: unknown, json: boolean): void {
  const code = error instanceof ModelClientError ? error.code : "USAGE_ERROR";
  const message = redactSensitiveText(
    error instanceof Error ? error.message : "Unknown command failure.",
  );
  if (json) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: { code, message } }, undefined, 2)}\n`,
    );
  } else {
    process.stderr.write(`${code}: ${message}\n`);
  }
}

export interface LmsAdvisoryResult {
  readonly command: string;
  readonly status: DiagnosticCheck["status"];
  readonly message: string;
}

export async function runLmsAdvisory(
  fixedArguments: readonly string[],
  timeoutMs = 10_000,
): Promise<LmsAdvisoryResult> {
  const command = `lms ${fixedArguments.join(" ")}`;
  return new Promise<LmsAdvisoryResult>((resolve) => {
    const child = spawn("lms", [...fixedArguments], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: minimalCliEnvironment(),
    });
    let settled = false;
    let outputBytes = 0;
    const countOutput = (chunk: Buffer) => {
      outputBytes = Math.min(outputBytes + chunk.byteLength, 128 * 1_024);
    };
    child.stdout.on("data", countOutput);
    child.stderr.on("data", countOutput);
    const finish = (result: LmsAdvisoryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({
        command,
        status: "WARNING",
        message: "Advisory lms command timed out; inspect LM Link manually.",
      });
    }, timeoutMs);
    timer.unref();
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        command,
        status: error.code === "ENOENT" ? "SKIPPED" : "WARNING",
        message:
          error.code === "ENOENT"
            ? "The optional lms CLI is not installed or not on PATH."
            : "The optional lms CLI advisory check could not start.",
      });
    });
    child.once("exit", (code) => {
      finish({
        command,
        status: code === 0 ? "PASS" : "WARNING",
        message:
          code === 0
            ? `Advisory command completed (${outputBytes} bounded output bytes); this is not proof of remote execution.`
            : `Advisory command exited with code ${code ?? "unknown"}; inspect LM Link manually.`,
      });
    });
  });
}

function minimalCliEnvironment(): NodeJS.ProcessEnv {
  const names =
    process.platform === "win32" ? ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR"] : ["PATH", "HOME"];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}
