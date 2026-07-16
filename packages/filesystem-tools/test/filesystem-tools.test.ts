import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  ReadFileTool,
  ToolFactory,
  type GuardedWorkspacePath,
  type WorkspaceGuardLike,
} from "../src/index.js";
import { WorkspaceGuard } from "../../workspace-security/src/index.js";

describe("filesystem tools", () => {
  let workspace: string;
  let guard: TestWorkspaceGuard;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "local-agent-fs-tools-"));
    guard = new TestWorkspaceGuard(workspace);
    await mkdir(join(workspace, "nested"));
    await writeFile(join(workspace, "b.txt"), "second\nneedle two\n", "utf8");
    await writeFile(join(workspace, "a.txt"), "first\nneedle one\n", "utf8");
    await writeFile(join(workspace, "nested", "c.txt"), "third\n", "utf8");
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("lists deterministically and searches text", async () => {
    const tools = ToolFactory.create(guard);
    const listed = await tools.listFiles.execute({ path: ".", recursive: true });
    expect(listed.entries.map((entry) => entry.path)).toEqual([
      "a.txt",
      "b.txt",
      "nested",
      "nested/c.txt",
    ]);

    const searched = await tools.searchText.execute({
      path: ".",
      query: "needle",
    });
    expect(searched.matches.map((match) => [match.path, match.line])).toEqual([
      ["a.txt", 2],
      ["b.txt", 2],
    ]);
  });

  it("lists and searches the workspace root through the production guard", async () => {
    const productionGuard = await WorkspaceGuard.create(workspace);
    const tools = ToolFactory.create(productionGuard);
    const listed = await tools.listFiles.execute({ path: ".", recursive: true });
    const searched = await tools.searchText.execute({ path: ".", query: "needle" });
    expect(listed.entries.map((entry) => entry.path)).toContain("a.txt");
    expect(searched.matches.map((match) => match.path)).toEqual(["a.txt", "b.txt"]);
  });

  it("reads bounded UTF-8 output and rejects binary files", async () => {
    const readTool = new ReadFileTool({ workspaceGuard: guard });
    const bounded = await readTool.execute({
      path: "a.txt",
      maxOutputBytes: 5,
    });
    expect(bounded.content).toBe("first");
    expect(bounded.truncated).toBe(true);

    await writeFile(join(workspace, "binary.dat"), Buffer.from([0, 1, 2]));
    await expect(readTool.execute({ path: "binary.dat" })).rejects.toMatchObject({
      code: "BINARY_FILE",
    });

    await writeFile(join(workspace, "oversized.txt"), Buffer.alloc(MAX_FILE_BYTES + 1, 97));
    await expect(readTool.execute({ path: "oversized.txt" })).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
  });

  it("atomically writes and leaves no temporary files", async () => {
    const tools = ToolFactory.create(guard);
    const before = await tools.readFile.execute({ path: "a.txt" });
    const result = await tools.writeFile.execute({
      path: "a.txt",
      content: "replacement\n",
      expectedSha256: before.sha256,
    });

    expect(result.beforeSha256).toBe(before.sha256);
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("replacement\n");
    expect((await readdir(workspace)).some((name) => name.endsWith(".local-agent-write.tmp"))).toBe(
      false,
    );
  });

  it("preserves an observed UTF-8 BOM, CRLF style, and final newline", async () => {
    const tools = ToolFactory.create(guard);
    await writeFile(join(workspace, "styled.txt"), "\uFEFFone\r\ntwo\r\n", "utf8");
    const before = await tools.readFile.execute({ path: "styled.txt" });
    const result = await tools.writeFile.execute({
      path: "styled.txt",
      content: "changed\ncontent",
      expectedSha256: before.sha256,
    });
    const written = await readFile(join(workspace, "styled.txt"), "utf8");
    expect(written).toBe("\uFEFFchanged\r\ncontent\r\n");
    expect(result.afterSha256).toBe(digest(written));
  });

  it("rejects unknown model-supplied fields and limits searches to 200 matches", async () => {
    const tools = ToolFactory.create(guard);
    await expect(
      tools.readFile.execute({ path: "a.txt", executable: "unsafe" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      tools.searchText.execute({ path: ".", query: "needle", maxResults: 201 }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("applies a hash-checked single-file patch and rolls back failures", async () => {
    const tools = ToolFactory.create(guard);
    const original = await readFile(join(workspace, "a.txt"), "utf8");
    const expectedSha256 = digest(original);
    const patch = [
      "--- a.txt",
      "+++ a.txt",
      "@@ -1,2 +1,2 @@",
      "-first",
      "+changed",
      " needle one",
      "",
    ].join("\n");
    await tools.applyPatch.execute({ path: "a.txt", patch, expectedSha256 });
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("changed\nneedle one\n");

    const changed = await readFile(join(workspace, "a.txt"), "utf8");
    const invalidPatch = [
      "--- a.txt",
      "+++ a.txt",
      "@@ -1,1 +1,1 @@",
      "-missing context",
      "+never written",
      "",
    ].join("\n");
    await expect(
      tools.applyPatch.execute({
        path: "a.txt",
        patch: invalidPatch,
        expectedSha256: digest(changed),
      }),
    ).rejects.toMatchObject({ code: "PATCH_FAILED" });
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(changed);
  });

  it("keeps dry-run mutations in a shared overlay", async () => {
    const tools = ToolFactory.create(guard, { dryRun: true });
    await tools.createFile.execute({ path: "virtual.txt", content: "draft needle\n" });
    const created = await tools.readFile.execute({ path: "virtual.txt" });
    await tools.writeFile.execute({
      path: "virtual.txt",
      content: "updated needle\n",
      expectedSha256: created.sha256,
    });

    const read = await tools.readFile.execute({ path: "virtual.txt" });
    const listed = await tools.listFiles.execute({ path: ".", recursive: true });
    const searched = await tools.searchText.execute({ path: ".", query: "updated" });
    expect(read.content).toBe("updated needle\n");
    expect(read.fromDryRunOverlay).toBe(true);
    expect(listed.entries).toContainEqual(
      expect.objectContaining({ path: "virtual.txt", fromDryRunOverlay: true }),
    );
    expect(searched.matches[0]).toMatchObject({
      path: "virtual.txt",
      fromDryRunOverlay: true,
    });
    await expect(access(join(workspace, "virtual.txt"))).rejects.toBeDefined();
  });
});

class TestWorkspaceGuard implements WorkspaceGuardLike {
  readonly #root: string;

  public constructor(root: string) {
    this.#root = resolve(root);
  }

  public async resolveForRead(relativePath: string): Promise<GuardedWorkspacePath> {
    return this.#resolve(relativePath);
  }

  public async resolveForWrite(
    relativePath: string,
    _options: Readonly<{ mustExist: boolean }>,
  ): Promise<GuardedWorkspacePath> {
    return this.#resolve(relativePath);
  }

  #resolve(requestedPath: string): GuardedWorkspacePath {
    if (isAbsolute(requestedPath) || requestedPath.includes("\0")) {
      throw new Error("unsafe path");
    }
    const absolutePath = resolve(this.#root, requestedPath);
    if (absolutePath !== this.#root && !absolutePath.startsWith(`${this.#root}${sep}`)) {
      throw new Error("outside workspace");
    }
    const relativePath = relative(this.#root, absolutePath).replaceAll("\\", "/") || ".";
    return { absolutePath, relativePath };
  }
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
