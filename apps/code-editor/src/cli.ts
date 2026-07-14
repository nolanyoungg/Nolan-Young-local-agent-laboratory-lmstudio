#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentRuntimeError } from "@local-agent-lab/agent-runtime";
import { ModelClientError } from "@local-agent-lab/local-model-client";
import { TraceError, sanitizedError } from "@local-agent-lab/tracing";
import { WorkspaceLockError, WorkspaceSecurityError } from "@local-agent-lab/workspace-security";
import { ZodError } from "zod";

import {
  CODE_EDITOR_HELP,
  CodeEditorUsageError,
  loadCodeEditorConfig,
  parseCliArguments,
  type LoadConfigurationOptions,
} from "./Configuration.js";
import { runCodeEditor, type CodeEditorWorkflowDependencies } from "./CodeEditorWorkflow.js";
import { CliExitCode, type CodeEditorExitCode } from "./types.js";

export interface CodeEditorCliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

export interface CodeEditorCliOptions {
  readonly configuration?: LoadConfigurationOptions;
  readonly workflow?: CodeEditorWorkflowDependencies;
}

const DEFAULT_IO: CodeEditorCliIo = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
};

export async function runCodeEditorCli(
  argv: readonly string[],
  io: CodeEditorCliIo = DEFAULT_IO,
  options: CodeEditorCliOptions = {},
): Promise<CodeEditorExitCode> {
  try {
    const arguments_ = parseCliArguments(argv);
    if (arguments_.help) {
      io.stdout(CODE_EDITOR_HELP);
      return CliExitCode.success;
    }
    const config = await loadCodeEditorConfig(arguments_, options.configuration);
    const outcome = await runCodeEditor(config, options.workflow);
    io.stdout(
      `Code editor ${outcome.status}. Run report: ${outcome.runDirectory.finalReportPath}\n`,
    );
    return outcome.success ? CliExitCode.success : CliExitCode.workflowFailure;
  } catch (error) {
    const exitCode = classifyExitCode(error, options.workflow?.signal);
    const failure = sanitizedError(error);
    io.stderr(`Code editor failed [${failure.code ?? failure.name}]: ${failure.message}\n`);
    if (exitCode === CliExitCode.usage) {
      io.stderr("Run with --help for usage.\n");
    }
    return exitCode;
  }
}

export function classifyExitCode(error: unknown, signal?: AbortSignal): CodeEditorExitCode {
  if (signal?.aborted === true || isAbortError(error)) {
    return CliExitCode.interrupted;
  }
  if (error instanceof CodeEditorUsageError || error instanceof ZodError) {
    return CliExitCode.usage;
  }
  if (
    error instanceof ModelClientError ||
    error instanceof TraceError ||
    error instanceof WorkspaceLockError
  ) {
    return CliExitCode.infrastructure;
  }
  if (error instanceof AgentRuntimeError) {
    return error.code === "TOOL_EXECUTION_FAILED"
      ? CliExitCode.workflowFailure
      : CliExitCode.infrastructure;
  }
  if (error instanceof WorkspaceSecurityError) {
    return CliExitCode.usage;
  }
  return CliExitCode.infrastructure;
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  try {
    process.exitCode = await runCodeEditorCli(process.argv.slice(2), DEFAULT_IO, {
      workflow: { signal: controller.signal },
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  path.resolve(entryPoint) === path.resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
