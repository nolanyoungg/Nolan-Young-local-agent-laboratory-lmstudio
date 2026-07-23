import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const completedStages = [
  "inventory",
  "data-flow",
  "defects",
  "operational-quality",
  "evidence-validation",
] as const;

const findingSchema = z
  .object({
    severity: z.enum(["low", "medium", "high", "critical"]),
    title: z.string().min(1),
    path: z.string().min(1),
    evidence: z.string().min(1),
    impact: z.string().min(1),
    recommendation: z.string().min(1),
    confidence: z.enum(["low", "medium", "high"]),
    limitations: z.array(z.string()),
    fingerprint: z.string().regex(/^[a-f0-9]{24}$/),
  })
  .strict();

const reviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    agent: z.literal("github-repo-review"),
    workspace: z.string().min(1),
    completedStages: z
      .array(z.enum(completedStages))
      .length(completedStages.length)
      .refine(
        (stages) => stages.every((stage, index) => stage === completedStages[index]),
        "The review artifact must complete all five review stages in order.",
      ),
    findings: z.array(findingSchema),
    limitations: z.array(z.string()),
  })
  .passthrough();

export type ReviewFinding = z.infer<typeof findingSchema>;
export type IssueRun = {
  repository: string;
  mode: "dry-run" | "publish";
  created: { fingerprint: string; url?: string }[];
  skipped: { fingerprint: string; reason: string }[];
  rejected: { fingerprint?: string; reason: string }[];
};

type GitHubIssue = { body?: string | null; html_url?: string; pull_request?: unknown };

export function issueBody(finding: ReviewFinding): string {
  return `<!-- review-fingerprint:${finding.fingerprint} -->
# ${finding.title}

## Evidence

- **Path:** \`${finding.path}\`
- ${finding.evidence}

## Impact

${finding.impact}

## Recommended resolution

${finding.recommendation}

## Review context

- **Confidence:** ${finding.confidence}
- **Limitations:** ${finding.limitations.join("; ") || "None recorded."}

This issue was created by the repository review pipeline; verify the change in the affected runtime before closing it.
`;
}

export function repositoryFromRemote(remote: string): string {
  const match = remote.trim().match(/(?:github\.com[/:])([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (!match) throw new Error("The repository origin is not a supported GitHub remote.");
  return `${match[1]}/${match[2]}`;
}

export async function resolveRepository(workspace: string, override?: string): Promise<string> {
  if (override) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(override)) throw new Error("--repository must be owner/repository.");
    return override;
  }
  const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: workspace });
  return repositoryFromRemote(stdout);
}

function reviewFingerprintInIssue(issue: GitHubIssue): string[] {
  if (issue.pull_request) return [];
  return [...(issue.body ?? "").matchAll(/<!-- review-fingerprint:([a-f0-9]{24}) -->/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

async function githubRequest(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
}

async function ensureLabel(token: string, repository: string, name: string, color: string): Promise<void> {
  const existing = await githubRequest(token, `/repos/${repository}/labels/${encodeURIComponent(name)}`);
  if (existing.ok) return;
  if (existing.status !== 404) throw new Error(`GitHub label lookup for ${name} failed (${existing.status}).`);

  const created = await githubRequest(token, `/repos/${repository}/labels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      color,
      description: "Created by the automated repository review pipeline",
    }),
  });
  if (!created.ok && created.status !== 422)
    throw new Error(`GitHub label creation for ${name} failed (${created.status}).`);
}

async function openFingerprints(token: string, repository: string): Promise<Set<string>> {
  const fingerprints = new Set<string>();
  for (let page = 1; page <= 100; page += 1) {
    const response = await githubRequest(
      token,
      `/repos/${repository}/issues?state=open&labels=automated-review&per_page=100&page=${page}`,
    );
    if (!response.ok) throw new Error(`GitHub issue lookup failed (${response.status}).`);
    const issues = (await response.json()) as GitHubIssue[];
    for (const issue of issues) for (const fingerprint of reviewFingerprintInIssue(issue)) fingerprints.add(fingerprint);
    if (issues.length < 100) break;
  }
  return fingerprints;
}

function uniqueFindings(findings: ReviewFinding[], run: IssueRun): ReviewFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (!seen.has(finding.fingerprint)) {
      seen.add(finding.fingerprint);
      return true;
    }
    run.rejected.push({ fingerprint: finding.fingerprint, reason: "Duplicate fingerprint in review artifact." });
    return false;
  });
}

function labelColor(severity: ReviewFinding["severity"]): string {
  return { low: "0e8a16", medium: "fbca04", high: "d93f0b", critical: "b60205" }[severity];
}

export async function publishReview(input: {
  reviewPath: string;
  workspace: string;
  repository?: string;
  publish: boolean;
}): Promise<IssueRun> {
  const review = reviewSchema.parse(JSON.parse(await readFile(input.reviewPath, "utf8")));
  const repository = await resolveRepository(resolve(input.workspace), input.repository);
  const run: IssueRun = {
    repository,
    mode: input.publish ? "publish" : "dry-run",
    created: [],
    skipped: [],
    rejected: [],
  };
  const candidates = uniqueFindings(review.findings, run);

  if (!input.publish) {
    run.created.push(...candidates.map((finding) => ({ fingerprint: finding.fingerprint })));
    return run;
  }

  const token = process.env["GH_TOKEN"];
  if (!token) throw new Error("GH_TOKEN is required with --publish.");
  await ensureLabel(token, repository, "automated-review", "5319e7");
  for (const severity of ["low", "medium", "high", "critical"] as const)
    await ensureLabel(token, repository, `severity:${severity}`, labelColor(severity));

  const existing = await openFingerprints(token, repository);
  for (const finding of candidates) {
    if (existing.has(finding.fingerprint)) {
      run.skipped.push({
        fingerprint: finding.fingerprint,
        reason: "Matching open automated-review issue exists.",
      });
      continue;
    }
    const response = await githubRequest(token, `/repos/${repository}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `[${finding.severity}] ${finding.title}`,
        body: issueBody(finding),
        labels: ["automated-review", `severity:${finding.severity}`],
      }),
    });
    if (!response.ok) {
      run.rejected.push({
        fingerprint: finding.fingerprint,
        reason: `GitHub issue creation failed (${response.status}).`,
      });
      continue;
    }
    const created = (await response.json()) as GitHubIssue;
    run.created.push({
      fingerprint: finding.fingerprint,
      ...(created.html_url ? { url: created.html_url } : {}),
    });
  }
  return run;
}

export const reviewFingerprint = (path: string, title: string, evidence: string): string =>
  createHash("sha256")
    .update(`${path}\n${title.trim().toLowerCase()}\n${evidence.trim()}`)
    .digest("hex")
    .slice(0, 24);