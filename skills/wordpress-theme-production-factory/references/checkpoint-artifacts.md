# Checkpoint Artifacts

Create these files in the approved documentation location. Keep entries append-only where practical so a resumed session can verify prior work.

## Requirement matrix

| ID  | Requirement | Source | Implementation location | Validation method | Status | Evidence/assumption |
| --- | ----------- | ------ | ----------------------- | ----------------- | ------ | ------------------- |

Use statuses `NOT STARTED`, `IN PROGRESS`, `COMPLETE`, `DEFERRED`, `BLOCKED`, or `FAILED`.

## Implementation plan

Record detected architecture and compatibility; root/template/part/PHP/hook design; assets/build/CSS/JS; dependencies; a11y/i18n; package rules; validation sequence; rollback/recovery; and phase order. Identify decisions that need approval.

## Progress log entry

```markdown
## YYYY-MM-DD — Phase N: name

- Completed work:
- Files created/changed/removed:
- Validation commands (working directory) and results:
- Failures/warnings/blocked checks:
- Assumptions and approvals:
- Remaining work:
- Next resumable phase:
```

## Release-readiness report

Record theme identity/architecture, matrix summary, files and checks, PHP/build/asset/package results, ZIP root and path, known warnings/blocked checks/deferrals, minimal remediation, deployment checklist, and final status. Do not mark blocked runtime validation as passed.
