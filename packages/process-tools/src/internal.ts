import { spawn, type ChildProcess } from "node:child_process";
import type { TrustedCommandDefinition } from "./CommandAllowlist.js";
import { createSanitizedEnvironment } from "./environment.js";
import { ProcessToolError } from "./errors.js";
import { ProcessLogStore } from "./ProcessLogStore.js";
import type { ProcessStatusStore } from "./ProcessStatusStore.js";

export interface SpawnedCommand {
  readonly child: ChildProcess;
  readonly logs: ProcessLogStore;
  readonly startedAtMs: number;
}

export function spawnTrustedCommand(
  definition: TrustedCommandDefinition,
  statusStore: ProcessStatusStore,
): SpawnedCommand {
  const logs = new ProcessLogStore();
  let child: ChildProcess;
  try {
    child = spawn(definition.executable, [...definition.args], {
      cwd: definition.cwd,
      env: createSanitizedEnvironment(definition),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new ProcessToolError(
      "PROCESS_SPAWN_FAILED",
      `Unable to spawn allowlisted command ${definition.id}.`,
      { cause: error },
    );
  }

  child.stdout?.on("data", (chunk: Buffer) => logs.append("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => logs.append("stderr", chunk));
  if (child.pid !== undefined) {
    statusStore.begin(definition.id, child.pid);
  }
  return { child, logs, startedAtMs: Date.now() };
}

export function processExitPromise(child: ChildProcess): Promise<{
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      reject(
        new ProcessToolError(
          "PROCESS_SPAWN_FAILED",
          "An allowlisted child process failed to start.",
          { cause: error },
        ),
      );
    });
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}
