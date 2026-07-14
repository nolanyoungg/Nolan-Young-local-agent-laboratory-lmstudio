import path from "node:path";

import type { MutationJournalEntry } from "@local-agent-lab/agent-runtime";
import { ReportWriter, redact, sanitizedError, type RunDirectory } from "@local-agent-lab/tracing";

import type { CodeEditorConfig } from "./Configuration.js";
import type { ChangedFileRecord, MutationJournal } from "./Tooling.js";
import type { CodeEditorMode, EditorFinal, PlannerFinal, ReviewerFinal } from "./types.js";

export type CodeEditorStatus =
  "plan-complete" | "repair-proposed" | "changes-applied" | "review-failed";

export interface CodeEditorOutcome {
  readonly runDirectory: RunDirectory;
  readonly mode: CodeEditorMode;
  readonly status: CodeEditorStatus;
  readonly success: boolean;
  readonly planner: PlannerFinal;
  readonly editorRuns: readonly EditorFinal[];
  readonly reviews: readonly ReviewerFinal[];
  readonly changedFiles: readonly ChangedFileRecord[];
  readonly proposedDiff: string;
  readonly editingSkipped: boolean;
  readonly reviewSkipped: boolean;
}

export class CodeEditorReportWriter {
  public constructor(private readonly writer = new ReportWriter()) {}

  public async writeOutcome(
    config: CodeEditorConfig,
    outcome: CodeEditorOutcome,
    journal: MutationJournal,
    operations: readonly MutationJournalEntry[],
  ): Promise<void> {
    const run = outcome.runDirectory;
    await Promise.all([
      this.writer.writeText(path.join(run.path, "change-plan.md"), renderPlan(outcome.planner)),
      this.writer.writeText(path.join(run.path, "proposed-diff.patch"), outcome.proposedDiff),
      this.writer.writeJson(path.join(run.path, "changed-files.json"), outcome.changedFiles),
      this.writer.writeJson(path.join(run.path, "mutation-metadata.json"), {
        operations,
        files: journal.changedFiles(),
      }),
      this.writer.writeText(
        path.join(run.path, "review-report.md"),
        renderReviews(outcome.reviews, outcome.reviewSkipped),
      ),
      this.writer.writeText(run.finalReportPath, renderFinalReport(config, outcome)),
      this.writer.writeJson(run.finalResultPath, {
        runId: run.runId,
        application: "code-editor",
        mode: outcome.mode,
        status: outcome.status,
        success: outcome.success,
        editingSkipped: outcome.editingSkipped,
        reviewSkipped: outcome.reviewSkipped,
        changedFiles: outcome.changedFiles,
        reviewPasses: outcome.reviews.length,
      }),
    ]);
  }

  public async writeFailure(
    config: CodeEditorConfig,
    run: RunDirectory,
    error: unknown,
    journal?: MutationJournal,
    operations: readonly MutationJournalEntry[] = [],
  ): Promise<void> {
    const failure = sanitizedError(error);
    const changedFiles = journal?.changedFiles() ?? [];
    const proposedDiff = journal?.unifiedDiff() ?? "";
    await Promise.all([
      this.writer.writeText(
        path.join(run.path, "change-plan.md"),
        "# Change Plan\n\nPlanning did not complete.\n",
      ),
      this.writer.writeText(path.join(run.path, "proposed-diff.patch"), proposedDiff),
      this.writer.writeJson(path.join(run.path, "changed-files.json"), changedFiles),
      this.writer.writeJson(path.join(run.path, "mutation-metadata.json"), {
        operations,
        files: changedFiles,
      }),
      this.writer.writeText(
        path.join(run.path, "review-report.md"),
        "# Review Report\n\nReview execution did not complete.\n",
      ),
      this.writer.writeText(
        run.finalReportPath,
        `# Code Editor Final Report

- Run: \`${run.runId}\`
- Mode: \`${config.mode}\`
- Status: \`failed\`
- Workspace changes retained: ${changedFiles.length}

The workflow failed with \`${failure.code ?? failure.name}\`: ${failure.message}

Already completed independent edits are not silently rolled back.
`,
      ),
      this.writer.writeJson(run.finalResultPath, {
        runId: run.runId,
        application: "code-editor",
        mode: config.mode,
        status: "failed",
        success: false,
        error: failure,
        changedFiles,
      }),
    ]);
  }
}

function renderPlan(plan: PlannerFinal): string {
  const lines = [
    "# Change Plan",
    "",
    safeText(plan.summary),
    "",
    "## Evidence",
    "",
    ...renderItems(plan.evidence, "No evidence was recorded."),
    "",
    "## Findings",
    "",
    ...renderItems(plan.findings, "No planning findings."),
    "",
    "## Planned Changes",
    "",
  ];
  if (plan.changePlan.length === 0) {
    lines.push("No file changes are planned.");
  } else {
    for (const [index, item] of plan.changePlan.entries()) {
      lines.push(
        `### ${index + 1}. ${safeText(item.action)}`,
        "",
        ...(item.path === undefined ? [] : [`Path: \`${safeText(item.path)}\``, ""]),
        safeText(item.rationale),
        "",
        "Acceptance criteria:",
        "",
        ...renderItems(item.acceptanceCriteria, "No criteria supplied."),
        "",
      );
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderReviews(reviews: readonly ReviewerFinal[], skipped: boolean): string {
  if (skipped) {
    return "# Review Report\n\nEditing and review execution were skipped in plan-only mode.\n";
  }
  const lines = ["# Review Report", ""];
  for (const [index, review] of reviews.entries()) {
    lines.push(
      `## Pass ${index + 1}: ${review.approved ? "Approved" : "Changes required"}`,
      "",
      safeText(review.summary),
      "",
    );
    if (review.findings.length === 0) {
      lines.push("No findings.", "");
    } else {
      for (const finding of review.findings) {
        lines.push(`- **${finding.severity.toUpperCase()}** ${safeText(finding.message)}`);
      }
      lines.push("");
    }
    if (review.requiredChanges.length > 0) {
      lines.push("Required changes:", "", ...renderItems(review.requiredChanges, ""), "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderFinalReport(config: CodeEditorConfig, outcome: CodeEditorOutcome): string {
  const review = outcome.reviews.at(-1);
  const modeNote =
    outcome.mode === "plan-only"
      ? "Editing and review execution were skipped; the proposed diff is intentionally empty."
      : outcome.mode === "dry-run"
        ? "All proposed edits and review reads used the virtual overlay; the target workspace was not mutated."
        : "Changes were applied atomically per file. No commit, push, or rollback was performed.";
  return `# Code Editor Final Report

- Run: \`${outcome.runDirectory.runId}\`
- Mode: \`${outcome.mode}\`
- Status: \`${outcome.status}\`
- Success: ${outcome.success ? "yes" : "no"}
- Changed files: ${outcome.changedFiles.length}
- Review passes: ${outcome.reviews.length}

## Summary

${safeText(outcome.editorRuns.at(-1)?.summary ?? outcome.planner.summary)}

## Final Review

${safeText(review?.summary ?? "Review was skipped.")}

${modeNote}

Task: ${safeText(config.task)}
`;
}

function renderItems(items: readonly string[], fallback: string): string[] {
  return items.length === 0 ? [fallback] : items.map((item) => `- ${safeText(item)}`);
}

function safeText(value: string): string {
  return String(redact(value));
}
