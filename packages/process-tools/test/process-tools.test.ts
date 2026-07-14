import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CommandAllowlist,
  MAX_PROCESS_LOG_BYTES,
  MAX_PROCESS_TAIL_BYTES,
  OneShotCommandRunner,
  ProcessLogStore,
  WatcherManager,
  createNpmCommandDefinition,
  createSanitizedEnvironment,
  taskkillArguments,
  type TrustedCommandDefinitionInput,
} from "../src/index.js";

describe("process tools", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "local-agent-process-tools-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("runs an approved command and captures stdout and stderr", async () => {
    const allowlist = new CommandAllowlist([
      command("capture", ["-e", "process.stdout.write('hello'); process.stderr.write('warning');"]),
    ]);
    const result = await new OneShotCommandRunner(allowlist).run({
      commandId: "capture",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("warning");
    expect(result.timedOut).toBe(false);
  });

  it("rejects unknown commands and extra model-supplied fields", () => {
    const allowlist = new CommandAllowlist([command("approved", ["-e", ""])]);
    expect(() => allowlist.resolve({ commandId: "unknown" })).toThrowError(
      expect.objectContaining({ code: "COMMAND_NOT_ALLOWED" }),
    );
    expect(() => allowlist.resolve({ commandId: "approved", args: ["malicious"] })).toThrowError(
      expect.objectContaining({ code: "COMMAND_NOT_ALLOWED" }),
    );
  });

  it("strictly rejects unknown command-definition fields and NUL arguments", () => {
    expect(
      () =>
        new CommandAllowlist([
          { ...command("strict", ["-e", ""]), shell: true } as TrustedCommandDefinitionInput,
        ]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_COMMAND_DEFINITION" }));
    expect(() => new CommandAllowlist([command("nul", ["bad\0argument"])])).toThrowError(
      expect.objectContaining({ code: "INVALID_COMMAND_DEFINITION" }),
    );
  });

  it("times out and terminates a long-running process", async () => {
    const allowlist = new CommandAllowlist([
      command("timeout", ["-e", "setInterval(() => {}, 1000);"], 75),
    ]);
    const result = await new OneShotCommandRunner(allowlist).run({
      commandId: "timeout",
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode === 0).toBe(false);
  }, 10_000);

  it("terminates descendants rather than only the direct process", async () => {
    const marker = join(cwd, "descendant-survived.txt");
    const descendantScript = [
      "const { writeFileSync } = require('node:fs');",
      `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'alive'), 1200);`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' });`,
      "process.stdout.write(String(child.pid) + '\\n');",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const allowlist = new CommandAllowlist([command("tree-timeout", ["-e", parentScript], 500)]);
    let descendantPid: number | undefined;
    try {
      const result = await new OneShotCommandRunner(allowlist).run({
        commandId: "tree-timeout",
      });
      descendantPid = Number(result.stdout.trim());
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      expect(result.timedOut).toBe(true);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_300));
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (descendantPid !== undefined) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Expected when process-tree termination succeeded.
        }
      }
    }
  }, 10_000);

  it("reports an early watcher exit", async () => {
    const allowlist = new CommandAllowlist([
      command("short-watch", ["-e", "console.log('ready');"]),
    ]);
    const watchers = new WatcherManager(allowlist);
    const watcher = watchers.start({ commandId: "short-watch" });
    const result = await watcher.waitForExit();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ready");
    expect(result.stoppedByManager).toBe(false);
  });

  it("terminates an active watcher", async () => {
    const allowlist = new CommandAllowlist([
      command("watch", ["-e", "console.log('started'); setInterval(() => {}, 1000);"]),
    ]);
    const watchers = new WatcherManager(allowlist);
    const watcher = watchers.start({ commandId: "watch" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    await watcher.stop();
    const result = await watcher.waitForExit();
    expect(result.stoppedByManager).toBe(true);
    expect(watchers.listActive()).toHaveLength(0);
  }, 10_000);

  it("independently bounds both streams and retains marked model tails", () => {
    const logs = new ProcessLogStore(64, 48);
    logs.append("stdout", "a".repeat(80));
    logs.append("stderr", "b".repeat(80));
    const snapshot = logs.snapshot();
    expect(Buffer.byteLength(snapshot.stdout)).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(snapshot.stderr)).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(snapshot.stdoutTail)).toBeLessThanOrEqual(48);
    expect(Buffer.byteLength(snapshot.stderrTail)).toBeLessThanOrEqual(48);
    expect(snapshot.stdout).toContain("[TRUNCATED:");
    expect(snapshot.stderr).toContain("[TRUNCATED:");
    expect(snapshot.stdoutTail).toContain("[TRUNCATED:");
    expect(snapshot.stderrTail).toContain("[TRUNCATED:");
    expect(snapshot).toMatchObject({
      stdoutBytes: 80,
      stderrBytes: 80,
      stdoutTruncated: true,
      stderrTruncated: true,
      truncated: true,
    });
    expect(MAX_PROCESS_LOG_BYTES).toBe(10 * 1_024 * 1_024);
    expect(MAX_PROCESS_TAIL_BYTES).toBe(64 * 1_024);
  });

  it("builds npm commands as direct Node invocations and rejects npm.cmd", async () => {
    const npmCli = join(cwd, "npm-cli.js");
    const npmCmd = join(cwd, "npm.cmd");
    await writeFile(npmCli, "// test npm cli\n", "utf8");
    await writeFile(npmCmd, "@echo off\r\n", "utf8");
    const definition = await createNpmCommandDefinition(
      { id: "npm-build", cwd, args: ["run", "build"] },
      npmCli,
    );
    expect(definition.executable).toBe(process.execPath);
    expect(definition.args?.slice(1)).toEqual(["run", "build"]);
    expect(definition.args?.[0]).toMatch(/npm-cli\.js$/iu);
    expect(() => new CommandAllowlist([definition])).not.toThrow();
    await expect(
      createNpmCommandDefinition({ id: "npm-bad", cwd, args: [] }, npmCmd),
    ).rejects.toMatchObject({ code: "INVALID_NPM_EXEC_PATH" });
  });

  it("uses only fixed taskkill /T /F arguments with a numeric PID", () => {
    expect(taskkillArguments(1234)).toEqual(["/PID", "1234", "/T", "/F"]);
    expect(() => taskkillArguments(-1)).toThrowError(
      expect.objectContaining({ code: "PROCESS_TERMINATION_FAILED" }),
    );
    expect(() => taskkillArguments(Number.NaN)).toThrowError(
      expect.objectContaining({ code: "PROCESS_TERMINATION_FAILED" }),
    );
  });

  it("sanitizes child environments and rejects secret-like names", () => {
    const allowlist = new CommandAllowlist([
      {
        ...command("environment", ["-e", ""]),
        inheritEnvironment: ["NODE_ENV"],
      },
    ]);
    const definition = allowlist.resolve({ commandId: "environment" });
    const environment = createSanitizedEnvironment(definition, {
      NODE_ENV: "test",
      UNRELATED: "hidden",
    });
    expect(environment.NODE_ENV).toBe("test");
    expect(environment.UNRELATED).toBeUndefined();

    const secretAllowlist = new CommandAllowlist([
      {
        ...command("secret-env", ["-e", ""]),
        inheritEnvironment: ["API_TOKEN"],
      },
    ]);
    expect(() =>
      createSanitizedEnvironment(secretAllowlist.resolve({ commandId: "secret-env" }), {
        API_TOKEN: "do-not-copy",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_COMMAND_DEFINITION" }));
  });

  function command(
    id: string,
    args: readonly string[],
    timeoutMs = 5_000,
  ): TrustedCommandDefinitionInput {
    return {
      id,
      executable: process.execPath,
      args: [...args],
      cwd,
      timeoutMs,
    };
  }
});
