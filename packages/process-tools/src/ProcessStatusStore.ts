export type ProcessLifecycleStatus = "exited" | "failed" | "running" | "starting" | "stopping";

export interface ProcessStatusSnapshot {
  readonly commandId: string;
  readonly pid: number;
  readonly status: ProcessLifecycleStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export class ProcessStatusStore {
  readonly #statuses = new Map<number, ProcessStatusSnapshot>();

  public begin(commandId: string, pid: number): ProcessStatusSnapshot {
    const now = new Date().toISOString();
    const status: ProcessStatusSnapshot = Object.freeze({
      commandId,
      pid,
      status: "running",
      startedAt: now,
      updatedAt: now,
      exitCode: null,
      signal: null,
    });
    this.#statuses.set(pid, status);
    return status;
  }

  public update(
    pid: number,
    update: Readonly<{
      status: ProcessLifecycleStatus;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
    }>,
  ): ProcessStatusSnapshot | undefined {
    const current = this.#statuses.get(pid);
    if (current === undefined) {
      return undefined;
    }
    const next: ProcessStatusSnapshot = Object.freeze({
      ...current,
      status: update.status,
      updatedAt: new Date().toISOString(),
      exitCode: update.exitCode ?? current.exitCode,
      signal: update.signal ?? current.signal,
    });
    this.#statuses.set(pid, next);
    return next;
  }

  public get(pid: number): ProcessStatusSnapshot | undefined {
    return this.#statuses.get(pid);
  }

  public list(): readonly ProcessStatusSnapshot[] {
    return [...this.#statuses.values()].sort((left, right) => left.pid - right.pid);
  }
}
