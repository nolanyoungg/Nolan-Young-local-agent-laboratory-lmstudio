import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { hostname as getHostname } from "node:os";
import path from "node:path";

import { isNodeError, WorkspaceLockError } from "./errors.js";
import { canonicalizeWorkspaceRoot, isPathInside } from "./SymlinkGuard.js";

export const DEFAULT_STALE_LOCK_AGE_MS = 5 * 60 * 1_000;

export interface WorkspaceLockRecord {
  readonly version: 1;
  readonly workspaceRoot: string;
  readonly nonce: string;
  readonly pid: number;
  readonly hostname: string;
  readonly createdAt: string;
}

export interface AcquireWorkspaceLockOptions {
  readonly workspaceRoot: string;
  readonly trustedLockRoot?: string;
  readonly lockRoot?: string;
  readonly staleAfterMs?: number;
  readonly hostname?: string;
  readonly pid?: number;
  readonly now?: () => Date;
  readonly nonceFactory?: () => string;
  readonly isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
}

type RequiredLockRuntimeOptions = Readonly<{
  hostname: string;
  isProcessAlive: (pid: number) => boolean | Promise<boolean>;
  nonceFactory: () => string;
  now: () => Date;
  pid: number;
  staleAfterMs: number;
}>;

function defaultProcessProbe(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function parseLockRecord(contents: string, lockPath: string): WorkspaceLockRecord {
  let candidate: unknown;
  try {
    candidate = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new WorkspaceLockError("LOCK_HELD", "Existing lock record is malformed", {
      cause: error,
      path: lockPath,
    });
  }

  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new WorkspaceLockError("LOCK_HELD", "Existing lock record is malformed", {
      path: lockPath,
    });
  }
  const record = candidate as Record<string, unknown>;
  if (
    record["version"] !== 1 ||
    typeof record["workspaceRoot"] !== "string" ||
    !path.isAbsolute(record["workspaceRoot"]) ||
    typeof record["nonce"] !== "string" ||
    record["nonce"].length === 0 ||
    typeof record["pid"] !== "number" ||
    !Number.isSafeInteger(record["pid"]) ||
    record["pid"] <= 0 ||
    typeof record["hostname"] !== "string" ||
    record["hostname"].length === 0 ||
    typeof record["createdAt"] !== "string" ||
    !Number.isFinite(Date.parse(record["createdAt"]))
  ) {
    throw new WorkspaceLockError("LOCK_HELD", "Existing lock record is invalid", {
      path: lockPath,
    });
  }

  return {
    version: 1,
    workspaceRoot: record["workspaceRoot"],
    nonce: record["nonce"],
    pid: record["pid"],
    hostname: record["hostname"],
    createdAt: record["createdAt"],
  };
}

async function inspectLock(lockPath: string): Promise<WorkspaceLockRecord> {
  let lockStat;
  try {
    lockStat = await lstat(lockPath);
  } catch (error) {
    throw new WorkspaceLockError("LOCK_IO", "Existing workspace lock cannot be inspected", {
      cause: error,
      path: lockPath,
    });
  }
  if (lockStat.isSymbolicLink() || !lockStat.isFile()) {
    throw new WorkspaceLockError(
      "LOCK_HELD",
      "Existing workspace lock is not a regular trusted file",
      { path: lockPath },
    );
  }

  const contents = await readFile(lockPath, "utf8");
  if (contents.length > 16_384) {
    throw new WorkspaceLockError("LOCK_HELD", "Existing workspace lock is oversized", {
      path: lockPath,
    });
  }
  return parseLockRecord(contents, lockPath);
}

async function publishLock(
  lockPath: string,
  lockRoot: string,
  record: WorkspaceLockRecord,
): Promise<boolean> {
  const temporaryPath = path.join(lockRoot, `.${path.basename(lockPath)}.${record.nonce}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, lockPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return false;
    }
    throw new WorkspaceLockError("LOCK_IO", "Workspace lock could not be published", {
      cause: error,
      path: lockPath,
    });
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

async function prepareTrustedLockRoot(
  requestedLockRoot: string,
  workspaceRoot: string,
): Promise<string> {
  if (!path.isAbsolute(requestedLockRoot)) {
    throw new WorkspaceLockError("LOCK_IO", "Trusted lock root must be absolute", {
      path: requestedLockRoot,
    });
  }

  const absoluteRequestedRoot = path.resolve(requestedLockRoot);
  if (isPathInside(workspaceRoot, absoluteRequestedRoot)) {
    throw new WorkspaceLockError(
      "LOCK_IO",
      "Trusted lock root must be outside the target workspace",
      { path: absoluteRequestedRoot },
    );
  }

  await mkdir(absoluteRequestedRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(absoluteRequestedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new WorkspaceLockError(
      "LOCK_IO",
      "Trusted lock root must be a real directory, not a symlink or junction",
      { path: absoluteRequestedRoot },
    );
  }

  const canonicalLockRoot = path.resolve(await realpath(absoluteRequestedRoot));
  if (isPathInside(workspaceRoot, canonicalLockRoot)) {
    throw new WorkspaceLockError(
      "LOCK_IO",
      "Trusted lock root must be outside the target workspace",
      { path: canonicalLockRoot },
    );
  }
  return canonicalLockRoot;
}

function lockKey(workspaceRoot: string): string {
  const identity = process.platform === "win32" ? workspaceRoot.toLowerCase() : workspaceRoot;
  return createHash("sha256").update(identity).digest("hex");
}

async function isStale(
  record: WorkspaceLockRecord,
  options: RequiredLockRuntimeOptions,
): Promise<boolean> {
  if (record.hostname.toLowerCase() !== options.hostname.toLowerCase()) {
    return false;
  }
  const ageMs = options.now().getTime() - Date.parse(record.createdAt);
  if (ageMs < options.staleAfterMs) {
    return false;
  }
  return !(await options.isProcessAlive(record.pid));
}

export class WorkspaceLock {
  public readonly lockPath: string;
  public readonly nonce: string;
  public readonly record: WorkspaceLockRecord;
  public readonly workspaceRoot: string;
  #released = false;

  private constructor(lockPath: string, record: WorkspaceLockRecord) {
    this.lockPath = lockPath;
    this.nonce = record.nonce;
    this.record = record;
    this.workspaceRoot = record.workspaceRoot;
  }

  public static async acquire(options: AcquireWorkspaceLockOptions): Promise<WorkspaceLock> {
    const requestedLockRoot = options.trustedLockRoot ?? options.lockRoot;
    if (requestedLockRoot === undefined) {
      throw new WorkspaceLockError("LOCK_IO", "A trusted lock root is required");
    }

    const runtime: RequiredLockRuntimeOptions = {
      hostname: options.hostname ?? getHostname(),
      isProcessAlive: options.isProcessAlive ?? defaultProcessProbe,
      nonceFactory: options.nonceFactory ?? randomUUID,
      now: options.now ?? (() => new Date()),
      pid: options.pid ?? process.pid,
      staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_LOCK_AGE_MS,
    };
    if (!Number.isSafeInteger(runtime.pid) || runtime.pid <= 0) {
      throw new TypeError("Lock PID must be a positive safe integer");
    }
    if (!Number.isSafeInteger(runtime.staleAfterMs) || runtime.staleAfterMs < 300_000) {
      throw new TypeError("staleAfterMs must be at least five minutes");
    }

    const workspaceRoot = await canonicalizeWorkspaceRoot(options.workspaceRoot);
    const lockRoot = await prepareTrustedLockRoot(requestedLockRoot, workspaceRoot);
    const lockPath = path.join(lockRoot, `${lockKey(workspaceRoot)}.lock`);
    const record: WorkspaceLockRecord = {
      version: 1,
      workspaceRoot,
      nonce: runtime.nonceFactory(),
      pid: runtime.pid,
      hostname: runtime.hostname,
      createdAt: runtime.now().toISOString(),
    };

    if (await publishLock(lockPath, lockRoot, record)) {
      return new WorkspaceLock(lockPath, record);
    }

    const existing = await inspectLock(lockPath);
    if (!(await isStale(existing, runtime))) {
      throw new WorkspaceLockError("LOCK_HELD", "Workspace is already locked", {
        path: lockPath,
      });
    }

    const quarantinedPath = `${lockPath}.stale-${record.nonce}`;
    try {
      await rename(lockPath, quarantinedPath);
    } catch (error) {
      throw new WorkspaceLockError(
        "LOCK_HELD",
        "Workspace lock changed while stale recovery was attempted",
        { cause: error, path: lockPath },
      );
    }

    try {
      const quarantined = await inspectLock(quarantinedPath);
      if (quarantined.nonce !== existing.nonce) {
        await link(quarantinedPath, lockPath).catch(() => undefined);
        throw new WorkspaceLockError(
          "LOCK_HELD",
          "Workspace lock ownership changed during stale recovery",
          { path: lockPath },
        );
      }
      if (!(await publishLock(lockPath, lockRoot, record))) {
        throw new WorkspaceLockError(
          "LOCK_HELD",
          "Another process acquired the workspace during stale recovery",
          { path: lockPath },
        );
      }
      return new WorkspaceLock(lockPath, record);
    } finally {
      await unlink(quarantinedPath).catch(() => undefined);
    }
  }

  public get released(): boolean {
    return this.#released;
  }

  public async release(): Promise<void> {
    if (this.#released) {
      return;
    }

    let current: WorkspaceLockRecord;
    try {
      current = await inspectLock(this.lockPath);
    } catch (error) {
      if (error instanceof WorkspaceLockError && error.code === "LOCK_IO") {
        throw new WorkspaceLockError("LOCK_OWNERSHIP", "Owned lock no longer exists", {
          cause: error,
          path: this.lockPath,
        });
      }
      throw error;
    }

    if (current.nonce !== this.nonce || current.workspaceRoot !== this.workspaceRoot) {
      throw new WorkspaceLockError(
        "LOCK_OWNERSHIP",
        "Workspace lock nonce does not match; refusing to release another owner's lock",
        { path: this.lockPath },
      );
    }

    await unlink(this.lockPath);
    this.#released = true;
  }
}

export async function withWorkspaceLock<T>(
  options: AcquireWorkspaceLockOptions,
  operation: (lock: WorkspaceLock) => Promise<T>,
): Promise<T> {
  const lock = await WorkspaceLock.acquire(options);
  try {
    return await operation(lock);
  } finally {
    await lock.release();
  }
}
