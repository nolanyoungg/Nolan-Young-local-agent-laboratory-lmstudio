import type { ChildProcess } from "node:child_process";
import type { CommandAllowlist, CommandSelection } from "./CommandAllowlist.js";
import { ProcessToolError } from "./errors.js";
import { processExitPromise, spawnTrustedCommand } from "./internal.js";
import type { ProcessLogSnapshot } from "./ProcessLogStore.js";
import { PlatformProcessTreeTerminator, type ProcessTreeTerminator } from "./ProcessTermination.js";
import { ProcessStatusStore } from "./ProcessStatusStore.js";

export interface ProcessResult extends ProcessLogSnapshot {
  readonly commandId: string;
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export class OneShotCommandRunner {
  readonly #allowlist: CommandAllowlist;
  readonly #statusStore: ProcessStatusStore;
  readonly #terminator: ProcessTreeTerminator;
  readonly #active = new Set<ChildProcess>();

  public constructor(
    allowlist: CommandAllowlist,
    options: Readonly<{
      statusStore?: ProcessStatusStore;
      terminator?: ProcessTreeTerminator;
    }> = {},
  ) {
    this.#allowlist = allowlist;
    this.#statusStore = options.statusStore ?? new ProcessStatusStore();
    this.#terminator = options.terminator ?? new PlatformProcessTreeTerminator();
  }

  public async run(
    selection: CommandSelection,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<ProcessResult> {
    const definition = this.#allowlist.resolve(selection);
    if (options.signal?.aborted === true) {
      throw new ProcessToolError(
        "PROCESS_ABORTED",
        `Command was aborted before start: ${definition.id}`,
      );
    }

    const spawned = spawnTrustedCommand(definition, this.#statusStore);
    this.#active.add(spawned.child);
    const pid = spawned.child.pid;
    if (pid === undefined) {
      this.#active.delete(spawned.child);
      throw new ProcessToolError(
        "PROCESS_SPAWN_FAILED",
        `Command did not receive a process ID: ${definition.id}`,
      );
    }

    let timedOut = false;
    let aborted = false;
    let termination: Promise<void> | undefined;
    let rejectTerminationFailure: ((error: unknown) => void) | undefined;
    const terminationFailure = new Promise<never>((_resolve, reject) => {
      rejectTerminationFailure = reject;
    });
    const terminate = (): Promise<void> => {
      termination ??= this.#terminator.terminate(spawned.child);
      return termination;
    };
    const requestTermination = (): void => {
      void terminate().catch((error: unknown) => rejectTerminationFailure?.(error));
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      this.#statusStore.update(pid, { status: "stopping" });
      requestTermination();
    }, definition.timeoutMs);
    timeout.unref();
    const onAbort = (): void => {
      aborted = true;
      this.#statusStore.update(pid, { status: "stopping" });
      requestTermination();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const exited = await Promise.race([processExitPromise(spawned.child), terminationFailure]);
      await termination;
      this.#statusStore.update(pid, {
        status: exited.exitCode === 0 && !timedOut && !aborted ? "exited" : "failed",
        exitCode: exited.exitCode,
        signal: exited.signal,
      });
      if (aborted) {
        throw new ProcessToolError("PROCESS_ABORTED", `Command was aborted: ${definition.id}`);
      }
      return {
        commandId: definition.id,
        pid,
        exitCode: exited.exitCode,
        signal: exited.signal,
        timedOut,
        durationMs: Date.now() - spawned.startedAtMs,
        ...spawned.logs.snapshot(),
      };
    } catch (error) {
      this.#statusStore.update(pid, { status: "failed" });
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        if (spawned.child.exitCode === null && spawned.child.signalCode === null) {
          await terminate();
        }
      } finally {
        this.#active.delete(spawned.child);
      }
    }
  }

  public async stopAll(): Promise<void> {
    await Promise.all(
      [...this.#active].map(async (child) => {
        if (child.pid !== undefined) {
          this.#statusStore.update(child.pid, { status: "stopping" });
        }
        await this.#terminator.terminate(child);
      }),
    );
  }
}
