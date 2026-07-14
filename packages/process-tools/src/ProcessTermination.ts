import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { ProcessToolError } from "./errors.js";

export interface ProcessTreeTerminator {
  terminate(child: ChildProcess, options?: Readonly<{ graceMs?: number }>): Promise<void>;
}

export class PlatformProcessTreeTerminator implements ProcessTreeTerminator {
  public async terminate(
    child: ChildProcess,
    options: Readonly<{ graceMs?: number }> = {},
  ): Promise<void> {
    if (child.pid === undefined || hasExited(child)) {
      return;
    }
    const graceMs = options.graceMs ?? 2_000;

    if (process.platform === "win32") {
      const exitCode = await runTaskkill(child.pid);
      if (!(await waitForExit(child, graceMs))) {
        throw new ProcessToolError(
          "PROCESS_TERMINATION_FAILED",
          `taskkill.exe did not terminate process tree ${child.pid} (exit ${String(exitCode)}).`,
        );
      }
      return;
    }

    sendPosixGroupSignal(child.pid, "SIGTERM");
    if (await waitForExit(child, graceMs)) {
      return;
    }
    sendPosixGroupSignal(child.pid, "SIGKILL");
    if (!(await waitForExit(child, graceMs))) {
      throw new ProcessToolError(
        "PROCESS_TERMINATION_FAILED",
        `The process group for PID ${child.pid} did not exit after SIGKILL.`,
      );
    }
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function sendPosixGroupSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isNoSuchProcess(error)) {
      throw error;
    }
  }
}

export function taskkillArguments(pid: number): readonly string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new ProcessToolError(
      "PROCESS_TERMINATION_FAILED",
      "A process tree can be terminated only by a fixed positive numeric PID.",
    );
  }
  return ["/PID", String(pid), "/T", "/F"];
}

async function runTaskkill(pid: number): Promise<number | null> {
  const windowsDirectory = process.env["SystemRoot"] ?? process.env["WINDIR"] ?? "C:\\Windows";
  const executable = join(windowsDirectory, "System32", "taskkill.exe");
  return await new Promise<number | null>((resolve, reject) => {
    const taskkill = spawn(executable, [...taskkillArguments(pid)], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.once("error", (error) =>
      reject(
        new ProcessToolError(
          "PROCESS_TERMINATION_FAILED",
          "Unable to launch the fixed Windows taskkill.exe process-tree adapter.",
          { cause: error },
        ),
      ),
    );
    taskkill.once("close", (exitCode) => resolve(exitCode));
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    timeout.unref();
    const onExit = (): void => {
      cleanup();
      resolve(true);
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

function isNoSuchProcess(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH"
  );
}
