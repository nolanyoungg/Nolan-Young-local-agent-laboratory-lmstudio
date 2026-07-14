import type { CommandSelection } from "./CommandAllowlist.js";
import type { CommandAllowlist } from "./CommandAllowlist.js";
import { OneShotCommandRunner, type ProcessResult } from "./OneShotCommandRunner.js";
import { PlatformProcessTreeTerminator } from "./ProcessTermination.js";
import { ProcessStatusStore } from "./ProcessStatusStore.js";
import { WatcherManager, type WatcherHandle } from "./WatcherManager.js";

export class ProcessManager {
  public readonly statuses: ProcessStatusStore;
  public readonly oneShot: OneShotCommandRunner;
  public readonly watchers: WatcherManager;
  #shutdownHandler: (() => void) | undefined;

  public constructor(allowlist: CommandAllowlist) {
    const terminator = new PlatformProcessTreeTerminator();
    this.statuses = new ProcessStatusStore();
    this.oneShot = new OneShotCommandRunner(allowlist, {
      statusStore: this.statuses,
      terminator,
    });
    this.watchers = new WatcherManager(allowlist, {
      statusStore: this.statuses,
      terminator,
    });
  }

  public async runOneShot(
    selection: CommandSelection,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<ProcessResult> {
    return await this.oneShot.run(selection, options);
  }

  public startWatcher(selection: CommandSelection): WatcherHandle {
    return this.watchers.start(selection);
  }

  public installShutdownHandlers(): () => void {
    if (this.#shutdownHandler !== undefined) {
      return this.#shutdownHandler;
    }
    const handler = (): void => {
      process.exitCode = 130;
      void this.stopAll();
    };
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
    this.#shutdownHandler = () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
      this.#shutdownHandler = undefined;
    };
    return this.#shutdownHandler;
  }

  public async stopAll(): Promise<void> {
    await Promise.all([this.oneShot.stopAll(), this.watchers.stopAll()]);
  }

  public async dispose(): Promise<void> {
    this.#shutdownHandler?.();
    await this.stopAll();
  }
}
