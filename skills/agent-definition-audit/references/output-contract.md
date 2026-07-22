# Output contract

Use this contract with the workflow in SKILL.md.

## Evidence

- Identify exact paths, commands, environment, and inputs inspected.
- Label conclusions as confirmed, inferred, blocked, or not checked.
- Preserve secrets and unrelated user-owned work.

## Findings

For every finding, provide severity when applicable, evidence, impact, minimal remediation, and a verification step. Do not claim runtime behavior from static inspection alone.

## Handoff

Start from assets/report-template.md for a consistent human review artifact. Print it safely with node scripts/print-report-template.mjs; the helper never writes files or changes the target workspace.
