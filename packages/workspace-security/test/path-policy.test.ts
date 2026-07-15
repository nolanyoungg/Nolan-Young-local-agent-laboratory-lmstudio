import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_PATH_DEPTH,
  DEFAULT_MAX_PATH_SEGMENT_LENGTH,
  IgnoreMatcher,
  PathPolicy,
  ReadPolicy,
  validateRelativePath,
  WritePolicy,
} from "../src/index.js";

describe("relative path validation", () => {
  it("normalizes safe separators", () => {
    expect(validateRelativePath("src\\nested\\index.ts")).toBe("src/nested/index.ts");
    expect(validateRelativePath(".")).toBe(".");
  });

  it.each(["../outside.txt", "src/../../outside.txt", "src/../outside.txt"])(
    "rejects traversal path %s",
    (candidate) => {
      expect(() => validateRelativePath(candidate)).toThrowError(
        expect.objectContaining({ code: "PATH_TRAVERSAL" }),
      );
    },
  );

  it.each([
    "/etc/passwd",
    "C:\\Windows\\System32\\drivers\\etc\\hosts",
    "C:relative-drive-path",
    "\\\\server\\share\\secret.txt",
    "\\\\?\\C:\\Windows\\secret.txt",
    "\\\\?\\UNC\\server\\share\\secret.txt",
    "\\\\.\\PhysicalDrive0",
  ])("rejects absolute or device path %s", (candidate) => {
    expect(() => validateRelativePath(candidate)).toThrowError(
      expect.objectContaining({ code: "ABSOLUTE_PATH" }),
    );
  });

  it.each([
    "src/./index.ts",
    "src//index.ts",
    "src/index.ts/",
    "src/NUL.txt",
    "src/file.txt:secret",
    "src/trailing. ",
    "src/bad\0name",
  ])("rejects malformed path %s", (candidate) => {
    expect(() => validateRelativePath(candidate)).toThrow();
  });

  it("enforces path, segment, and depth limits", () => {
    expect(() =>
      validateRelativePath("a".repeat(DEFAULT_MAX_PATH_SEGMENT_LENGTH + 1)),
    ).toThrowError(expect.objectContaining({ code: "PATH_TOO_LONG" }));
    expect(() =>
      validateRelativePath(Array.from({ length: DEFAULT_MAX_PATH_DEPTH + 1 }, () => "a").join("/")),
    ).toThrowError(expect.objectContaining({ code: "PATH_TOO_LONG" }));
    expect(() => validateRelativePath("a".repeat(1_025))).toThrowError(
      expect.objectContaining({ code: "PATH_TOO_LONG" }),
    );
  });
});

describe("read and write policy", () => {
  it("allows read-only discovery at the workspace root by default", () => {
    const policy = new PathPolicy();
    expect(policy.assertAllowed(".", "read")).toBe(".");
  });

  it.each([
    ".git/config",
    "nested/.git/HEAD",
    ".env",
    "config/.env.production",
    "node_modules/pkg/index.js",
    "nested/node_modules/pkg/index.js",
    "private/server.pem",
    ".ssh/id_ed25519",
    "reports/run.json",
    ".npm/cache/file",
  ])("forbids protected path %s", (candidate) => {
    const policy = new PathPolicy();
    expect(() => policy.assertAllowed(candidate, "read")).toThrowError(
      expect.objectContaining({ code: "PATH_FORBIDDEN" }),
    );
  });

  it("applies deny rules before caller allow rules", () => {
    const policy = new PathPolicy({
      readGlobs: [".git/**"],
      writeGlobs: [".git/**"],
      forbiddenGlobs: ["src/private/**"],
    });
    expect(() => policy.assertAllowed(".git/config", "write")).toThrowError(
      expect.objectContaining({ code: "PATH_FORBIDDEN" }),
    );
    expect(() => policy.assertAllowed("src/private/key.txt", "read")).toThrowError(
      expect.objectContaining({ code: "PATH_FORBIDDEN" }),
    );
  });

  it("enforces independent read, write, and deletion allowlists", () => {
    const policy = new PathPolicy({
      readGlobs: ["src/**", "package.json"],
      writeGlobs: ["src/generated/**"],
      deleteGlobs: ["src/generated/*.tmp"],
    });
    const reads = new ReadPolicy(policy);
    const writes = new WritePolicy(policy);

    expect(reads.allows("src/index.ts")).toBe(true);
    expect(reads.allows("README.md")).toBe(false);
    expect(writes.allows("src/generated/output.ts")).toBe(true);
    expect(writes.allows("src/index.ts")).toBe(false);
    expect(writes.allowsDelete("src/generated/cache.tmp")).toBe(true);
    expect(writes.allowsDelete("src/generated/output.ts")).toBe(false);
  });

  it("disables deletion by default", () => {
    expect(() => new PathPolicy().assertAllowed("src/index.ts", "delete")).toThrowError(
      expect.objectContaining({ code: "DELETE_DENIED" }),
    );
  });
});

describe("ignore matcher", () => {
  it("supports ordered ignores and negation without changing security policy", () => {
    const matcher = new IgnoreMatcher(["dist/", "*.log", "!important.log"]);
    expect(matcher.isIgnored("dist/index.js")).toBe(true);
    expect(matcher.isIgnored("nested/debug.log")).toBe(true);
    expect(matcher.isIgnored("important.log")).toBe(false);
    expect(matcher.filter(["src/index.ts", "dist/index.js"])).toEqual(["src/index.ts"]);
  });

  it("parses comments and blank lines", () => {
    const matcher = IgnoreMatcher.fromText("# generated files\n\ncoverage/\n");
    expect(matcher.ignores("coverage/index.html")).toBe(true);
    expect(matcher.ignores("src/index.ts")).toBe(false);
  });
});
