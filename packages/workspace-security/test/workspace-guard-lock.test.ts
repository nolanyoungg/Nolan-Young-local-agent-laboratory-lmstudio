import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PathPolicy, WorkspaceGuard, WorkspaceLock } from "../src/index.js";

const temporaryRoots: string[] = [];

async function createFixture(): Promise<{
  readonly lockRoot: string;
  readonly root: string;
  readonly workspace: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "local-agent-security-"));
  temporaryRoots.push(root);
  const workspace = path.join(root, "workspace");
  const lockRoot = path.join(root, "trusted-locks");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "index.ts"), "export const value = 1;\n", "utf8");
  return { lockRoot, root, workspace };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

describe("WorkspaceGuard", () => {
  it("canonicalizes the root and resolves approved paths beneath it", async () => {
    const { workspace } = await createFixture();
    const guard = await WorkspaceGuard.create(workspace, {
      readGlobs: ["src/**"],
      writeGlobs: ["src/**"],
    });

    expect(guard.root).toBe(path.resolve(await realpath(workspace)));
    expect((await guard.resolveForRead("src\\index.ts")).absolutePath).toBe(
      path.join(guard.root, "src", "index.ts"),
    );
    expect((await guard.resolveForWrite("src/generated/new.ts")).relativePath).toBe(
      "src/generated/new.ts",
    );
  });

  it("enforces read and write policy at resolution time", async () => {
    const { workspace } = await createFixture();
    const guard = await WorkspaceGuard.create(workspace, {
      readGlobs: ["src/**"],
      writeGlobs: ["src/generated/**"],
    });

    await expect(guard.resolveForRead("README.md")).rejects.toMatchObject({
      code: "READ_DENIED",
    });
    await expect(guard.resolveForWrite("src/index.ts")).rejects.toMatchObject({
      code: "WRITE_DENIED",
    });
    await expect(guard.resolveForDelete("src/generated/file.ts")).rejects.toMatchObject({
      code: "DELETE_DENIED",
    });
  });

  it("rejects symlink or junction components even when their target is inside", async () => {
    const { workspace } = await createFixture();
    const target = path.join(workspace, "src");
    const link = path.join(workspace, "linked-src");
    try {
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EPERM") {
        return;
      }
      throw error;
    }

    const guard = await WorkspaceGuard.create(workspace);
    await expect(guard.resolveForRead("linked-src/index.ts")).rejects.toMatchObject({
      code: "SYMLINK_DETECTED",
    });
  });

  it("rejects symlink or junction escapes", async () => {
    const { root, workspace } = await createFixture();
    const outside = path.join(root, "outside");
    const link = path.join(workspace, "outside-link");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EPERM") {
        return;
      }
      throw error;
    }

    const guard = await WorkspaceGuard.create(workspace);
    await expect(guard.resolveForRead("outside-link/secret.txt")).rejects.toMatchObject({
      code: "SYMLINK_DETECTED",
    });
  });

  it("rejects a symlink or junction workspace root", async () => {
    const { root, workspace } = await createFixture();
    const linkedRoot = path.join(root, "linked-workspace");
    try {
      await symlink(workspace, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EPERM") {
        return;
      }
      throw error;
    }

    await expect(WorkspaceGuard.create(linkedRoot)).rejects.toMatchObject({
      code: "SYMLINK_DETECTED",
    });
  });

  it("uses Windows-style case-insensitive protected path matching", async () => {
    const { workspace } = await createFixture();
    const guard = await WorkspaceGuard.create(workspace, {
      pathPolicy: new PathPolicy({ readGlobs: ["**"] }),
    });

    await expect(guard.resolveForRead(".GiT/Config")).rejects.toMatchObject({
      code: "PATH_FORBIDDEN",
    });
    await expect(guard.resolveForRead(".ENV.Local")).rejects.toMatchObject({
      code: "PATH_FORBIDDEN",
    });
  });
});

describe("WorkspaceLock", () => {
  it("provides exclusive acquisition and permits reacquisition after owned release", async () => {
    const { lockRoot, workspace } = await createFixture();
    const first = await WorkspaceLock.acquire({
      workspaceRoot: workspace,
      trustedLockRoot: lockRoot,
    });

    await expect(
      WorkspaceLock.acquire({ workspaceRoot: workspace, trustedLockRoot: lockRoot }),
    ).rejects.toMatchObject({ code: "LOCK_HELD" });

    await first.release();
    expect(first.released).toBe(true);
    const next = await WorkspaceLock.acquire({
      workspaceRoot: workspace,
      trustedLockRoot: lockRoot,
    });
    await next.release();
  });

  it("recovers once only for an old same-host lock whose PID is absent", async () => {
    const { lockRoot, workspace } = await createFixture();
    let now = Date.parse("2026-07-13T12:00:00.000Z");
    const common = {
      workspaceRoot: workspace,
      trustedLockRoot: lockRoot,
      hostname: "test-host",
      isProcessAlive: (): boolean => false,
      now: (): Date => new Date(now),
    };
    const staleOwner = await WorkspaceLock.acquire(common);
    now += 5 * 60 * 1_000 + 1;

    const recovered = await WorkspaceLock.acquire(common);
    expect(recovered.nonce).not.toBe(staleOwner.nonce);
    await expect(staleOwner.release()).rejects.toMatchObject({ code: "LOCK_OWNERSHIP" });
    expect(await readFile(recovered.lockPath, "utf8")).toContain(recovered.nonce);
    await recovered.release();
  });

  it("does not recover a stale-looking lock from another hostname", async () => {
    const { lockRoot, workspace } = await createFixture();
    let now = Date.parse("2026-07-13T12:00:00.000Z");
    const owner = await WorkspaceLock.acquire({
      workspaceRoot: workspace,
      trustedLockRoot: lockRoot,
      hostname: "host-a",
      now: () => new Date(now),
    });
    now += 10 * 60 * 1_000;

    await expect(
      WorkspaceLock.acquire({
        workspaceRoot: workspace,
        trustedLockRoot: lockRoot,
        hostname: "host-b",
        now: () => new Date(now),
        isProcessAlive: () => false,
      }),
    ).rejects.toMatchObject({ code: "LOCK_HELD" });
    await owner.release();
  });

  it("does not recover while the recorded PID remains alive", async () => {
    const { lockRoot, workspace } = await createFixture();
    let now = Date.parse("2026-07-13T12:00:00.000Z");
    const owner = await WorkspaceLock.acquire({
      workspaceRoot: workspace,
      trustedLockRoot: lockRoot,
      hostname: "same-host",
      now: () => new Date(now),
    });
    now += 10 * 60 * 1_000;

    await expect(
      WorkspaceLock.acquire({
        workspaceRoot: workspace,
        trustedLockRoot: lockRoot,
        hostname: "same-host",
        now: () => new Date(now),
        isProcessAlive: () => true,
      }),
    ).rejects.toMatchObject({ code: "LOCK_HELD" });
    await owner.release();
  });

  it("refuses release after nonce ownership is replaced", async () => {
    const { lockRoot, workspace } = await createFixture();
    const lock = await WorkspaceLock.acquire({
      workspaceRoot: workspace,
      trustedLockRoot: lockRoot,
    });
    const record = JSON.parse(await readFile(lock.lockPath, "utf8")) as Record<string, unknown>;
    record["nonce"] = randomUUID();
    await writeFile(lock.lockPath, `${JSON.stringify(record)}\n`, "utf8");

    await expect(lock.release()).rejects.toMatchObject({ code: "LOCK_OWNERSHIP" });
    expect(await readFile(lock.lockPath, "utf8")).toContain(String(record["nonce"]));
  });

  it("requires the trusted lock root to be outside the target workspace", async () => {
    const { workspace } = await createFixture();
    await expect(
      WorkspaceLock.acquire({
        workspaceRoot: workspace,
        trustedLockRoot: path.join(workspace, ".locks"),
      }),
    ).rejects.toMatchObject({ code: "LOCK_IO" });
  });
});
