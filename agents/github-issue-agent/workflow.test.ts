import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueBody, publishReview, repositoryFromRemote } from "./workflow.js";

const finding = {
  severity: "high" as const,
  title: "Unchecked request result",
  path: "src/request.ts",
  evidence: "The response is used without checking its status.",
  impact: "Failures can be reported as successful work.",
  recommendation: "Check the result before using the response body.",
  confidence: "high" as const,
  limitations: ["Static review only."],
  fingerprint: "0123456789abcdef01234567",
};
const artifact = (findings = [finding]) => ({
  schemaVersion: 1,
  agent: "github-repo-review",
  workspace: "C:/reviewed-repository",
  completedStages: ["inventory", "data-flow", "defects", "operational-quality", "evidence-validation"],
  findings,
  limitations: ["Static analysis only."],
});

let temporaryDirectory: string | undefined;
async function reviewFile(value: unknown): Promise<string> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "github-issue-agent-"));
  const path = join(temporaryDirectory, "result.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("GitHub Issue Agent", () => {
  it("parses supported GitHub remotes and preserves fingerprint markers", () => {
    expect(repositoryFromRemote("git@github.com:owner/repo.git")).toBe("owner/repo");
    expect(repositoryFromRemote("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(() => repositoryFromRemote("https://example.test/owner/repo")).toThrow(/GitHub remote/);
    expect(issueBody(finding)).toContain("review-fingerprint:0123456789abcdef01234567");
  });

  it("requires a completed, five-stage reviewer artifact", async () => {
    const path = await reviewFile({ ...artifact(), completedStages: ["data-flow", "inventory", "defects", "operational-quality", "evidence-validation"] });
    await expect(
      publishReview({ reviewPath: path, workspace: ".", repository: "owner/repo", publish: false }),
    ).rejects.toThrow(/five review stages/);
  });

  it("proposes every unique finding during dry-run without GitHub access", async () => {
    const path = await reviewFile(artifact([finding, finding]));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await publishReview({
      reviewPath: path,
      workspace: ".",
      repository: "owner/repo",
      publish: false,
    });
    expect(result).toMatchObject({ mode: "dry-run", created: [{ fingerprint: finding.fingerprint }] });
    expect(result.rejected).toEqual([{ fingerprint: finding.fingerprint, reason: "Duplicate fingerprint in review artifact." }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires GH_TOKEN only for publishing and does not expose it", async () => {
    const path = await reviewFile(artifact());
    vi.stubEnv("GH_TOKEN", "");
    await expect(
      publishReview({ reviewPath: path, workspace: ".", repository: "owner/repo", publish: true }),
    ).rejects.toThrow("GH_TOKEN is required with --publish.");
  });

  it("creates missing labels, skips existing fingerprints, and creates only new issues", async () => {
    const second = { ...finding, fingerprint: "fedcba987654321001234567", title: "Second finding" };
    const path = await reviewFile(artifact([finding, second]));
    vi.stubEnv("GH_TOKEN", "token-that-must-not-appear");
    const calls: { path: string; method: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const pathValue = new URL(String(url)).pathname + new URL(String(url)).search;
      const method = init?.method ?? "GET";
      calls.push({ path: pathValue, method });
      if (method === "GET" && pathValue.includes("/labels/")) return new Response("", { status: 404 });
      if (method === "POST" && pathValue.endsWith("/labels")) return new Response("{}", { status: 201 });
      if (method === "GET" && pathValue.includes("/issues?"))
        return new Response(JSON.stringify([{ body: issueBody(finding) }]), { status: 200 });
      if (method === "POST" && pathValue.endsWith("/issues"))
        return new Response(JSON.stringify({ html_url: "https://github.com/owner/repo/issues/2" }), { status: 201 });
      return new Response("unexpected", { status: 500 });
    }));

    const result = await publishReview({
      reviewPath: path,
      workspace: ".",
      repository: "owner/repo",
      publish: true,
    });
    expect(result.skipped).toEqual([{ fingerprint: finding.fingerprint, reason: "Matching open automated-review issue exists." }]);
    expect(result.created).toEqual([{ fingerprint: second.fingerprint, url: "https://github.com/owner/repo/issues/2" }]);
    expect(calls.filter((call) => call.path.endsWith("/labels") && call.method === "POST")).toHaveLength(5);
    expect(calls.filter((call) => call.path.endsWith("/issues") && call.method === "POST")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("token-that-must-not-appear");
  });

  it("reports issue API failures without modifying an existing issue", async () => {
    const path = await reviewFile(artifact());
    vi.stubEnv("GH_TOKEN", "safe-token");
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const pathValue = new URL(String(url)).pathname + new URL(String(url)).search;
      const method = init?.method ?? "GET";
      if (method === "GET" && pathValue.includes("/labels/")) return new Response("{}", { status: 200 });
      if (method === "GET" && pathValue.includes("/issues?")) return new Response("[]", { status: 200 });
      if (method === "POST" && pathValue.endsWith("/issues")) return new Response("denied", { status: 403 });
      return new Response("unexpected", { status: 500 });
    }));
    const result = await publishReview({ reviewPath: path, workspace: ".", repository: "owner/repo", publish: true });
    expect(result.created).toEqual([]);
    expect(result.rejected).toEqual([{ fingerprint: finding.fingerprint, reason: "GitHub issue creation failed (403)." }]);
  });
});