# Automation API Pipeline Review

## Trigger

Use to review or improve an automation that fetches APIs, transforms data, creates CSV/PDF/HTML reports, sends email, or runs on a schedule (including inventory exports, WooCommerce sync, scorecards, Clarity reports, Power Automate, and scheduled C#). Start with read-only inspection. Do not use for an isolated API endpoint or email-template review.

## Workflow

1. Map `source/auth -> fetch/pagination -> filter/transform -> persist/output -> delivery -> schedule/alert`. Require exact entry point, schedule context, sample-safe inputs, destinations, and expected run summary.
2. Inspect OAuth/token lifecycle, secret/environment handling without printing secrets, pagination, malformed/null data, rate limits, retry/backoff/timeouts, idempotency/deduplication, logging, and failure-alert paths.
3. Validate output schema/content for CSV, PDF, and HTML; verify email recipient/delivery failure handling; inspect Windows Task Scheduler or equivalent job configuration and overlap/retry behavior.
4. Identify likely failure points with direct evidence. Test using safe sample data, dry-run/staging where possible, including partial pages, timeout, malformed response, duplicate run, output failure, and email failure.
5. Propose minimal changes that preserve delivery semantics, then verify run summary, logs, idempotency, and alerts.

## Output

Return the pipeline map, evidence table, likely failure points, safe test plan, exact working directories/commands, run-summary and alert expectations, remediation, and confirmed versus inferred conclusions.
