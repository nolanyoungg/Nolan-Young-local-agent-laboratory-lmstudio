import type { ChildProcess } from "node:child_process";
import type {
  CommandAllowlist,
  CommandSelection,
  TrustedCommandDefinition,
} from "./CommandAllowlist.js";
import { ProcessToolError } from "./errors.js";
import { processExitPromise, spawnTrustedCommand } from "./internal.js";
import type { ProcessLogSnapshot, ProcessLogStore } from "./ProcessLogStore.js";
import { PlatformProcessTreeTerminator, type ProcessTreeTerminator } from "./ProcessTermination.js";
import { ProcessStatusStore, type ProcessStatusSnapshot } from "./ProcessStatusStore.js";

export interface WatcherExitResult extends ProcessLogSnapshot {
  readonly commandId: string;
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly stoppedByManager: boolean;
}

export interface WatcherHandle {
  readonly commandId: string;
  readonly pid: number;
  getLogs(): ProcessLogSnapshot;
  getStatus(): ProcessStatusSnapshot | undefined;
  stop(): Promise<void>;
  waitForExit(): Promise<WatcherExitResult>;
}

class ManagedWatcher implements WatcherHandle {
  public readonly commandId: string;
  public readonly pid: number;
  readonly #child: ChildProcess;
  readonly #logs: ProcessLogStore;
  readonly #startedAtMs: number;
  readonly #statusStore: ProcessStatusStore;
  readonly #terminator: ProcessTreeTerminator;
  readonly #completion: Promise<WatcherExitResult>;
  #stoppedByManager = false;
  #termination: Promise<void> | undefined;

  public constructor(
    definition: TrustedCommandDefinition,
    child: ChildProcess,
    logs: ProcessLogStore,
    startedAtMs: number,
    statusStore: ProcessStatusStore,
    terminator: ProcessTreeTerminator,
  ) {
    this.commandId = definition.id;
    this.pid = child.pid as number;
    this.#child = child;
    this.#logs = logs;
    this.#startedAtMs = startedAtMs;
    this.#statusStore = statusStore;
    this.#terminator = terminator;
    this.#completion = this.#observeExit();
  }

  public getLogs(): ProcessLogSnapshot {
    return this.#logs.snapshot();
  }

  public getStatus(): ProcessStatusSnapshot | undefined {
    return this.#statusStore.get(this.pid);
  }

  public async stop(): Promise<void> {
    this.#stoppedByManager = true;
    this.#statusStore.update(this.pid, { status: "stopping" });
    this.#termination ??= this.#terminator.terminate(this.#child);
    await this.#termination;
    await this.#completion;
  }

  public async waitForExit(): Promise<WatcherExitResult> {
    return await this.#completion;
  }

  async #observeExit(): Promise<WatcherExitResult> {
    const exited = await processExitPromise(this.#child);
    this.#statusStore.update(this.pid, {
      status: exited.exitCode === 0 || this.#stoppedByManager ? "exited" : "failed",
      exitCode: exited.exitCode,
      signal: exited.signal,
    });
    return {
      commandId: this.commandId,
      pid: this.pid,
      exitCode: exited.exitCode,
      signal: exited.signal,
      durationMs: Date.now() - this.#startedAtMs,
      stoppedByManager: this.#stoppedByManager,
      ...this.#logs.snapshot(),
    };
  }
}

export class WatcherManager {
  readonly #allowlist: CommandAllowlist;
  readonly #statusStore: ProcessStatusStore;
  readonly #terminator: ProcessTreeTerminator;
  readonly #active = new Map<number, ManagedWatcher>();

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

  public start(selection: CommandSelection): WatcherHandle {
    const definition = this.#allowlist.resolve(selection);
    const spawned = spawnTrustedCommand(definition, this.#statusStore);
    if (spawned.child.pid === undefined) {
      throw new ProcessToolError(
        "PROCESS_SPAWN_FAILED",
        `Watcher did not receive a process ID: ${definition.id}`,
      );
    }
    const watcher = new ManagedWatcher(
      definition,
      spawned.child,
      spawned.logs,
      spawned.startedAtMs,
      this.#statusStore,
      this.#terminator,
    );
    this.#active.set(watcher.pid, watcher);
    void watcher
      .waitForExit()
      .catch(() => undefined)
      .finally(() => this.#active.delete(watcher.pid));
    return watcher;
  }

  public listActive(): readonly WatcherHandle[] {
    return [...this.#active.values()].sort((left, right) => left.pid - right.pid);
  }

  public async stopAll(): Promise<void> {
    await Promise.all([...this.#active.values()].map((watcher) => watcher.stop()));
  }
}
