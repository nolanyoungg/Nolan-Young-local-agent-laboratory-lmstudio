# Code Editor

Runs a read-only planner, controlled editor, and read-only reviewer against one locked workspace.

```bash
npm run code-editor -- --workspace ./examples/broken-typescript-project --task "Add robust numeric input validation" --mode plan-only
npm run code-editor -- --workspace ./examples/broken-typescript-project --task "Add robust numeric input validation" --mode dry-run
npm run code-editor -- --workspace ./examples/broken-typescript-project --task "Add robust numeric input validation" --mode apply
```

Dry-run uses an in-memory overlay and writes reports only. Apply never commits or pushes.

Use `--dry-run` as an alias for `--mode dry-run`; combining it with
`--mode plan-only` or `--mode apply` is a usage error. `--mock` explicitly
selects a deterministic scripted model and is never enabled as an automatic
fallback.

Each invocation acquires an exclusive workspace lock under the trusted report
root and writes a run directory containing `change-plan.md`,
`proposed-diff.patch`, `changed-files.json`, `mutation-metadata.json`,
`review-report.md`, `model-diagnostics.json`, `trace.jsonl`,
`final-result.json`, and the application-owned `final-report.md`. Plan-only
writes an empty proposed diff and marks editing and review as skipped. Dry-run
reviewers see all earlier overlay edits while the target workspace stays
unchanged.

```bash
npm run code-editor -- --workspace ./examples/sample-node-project --task "Inspect only" --mode dry-run --mock
npm run code-editor -- --help
```

Exit codes are `0` for success/help, `1` for an unresolved review, `2` for
usage or configuration errors, `3` for model/infrastructure failures, and
`130` for interruption.
