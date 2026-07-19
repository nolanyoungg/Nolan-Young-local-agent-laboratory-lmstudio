# Dependency Clean Install Review

## Trigger

Use when investigating `npm ci`, `npm install`, lockfile validity, dependency warnings/errors, or JavaScript build setup. Do not use merely to update packages or silence output.

## Workflow

1. Record exact working directory, package manager/version, Node/npm requirements, `package.json`, lockfile, `.npmrc`, build scripts, and CI commands. Start with read-only inspection.
2. Run the requested clean install only with explicit scope and preserve the lockfile unless an approved dependency change requires it. Capture warnings/errors without suppression.
3. Classify each material finding as direct/transitive, deprecation, advisory, lockfile drift, Node/npm incompatibility, peer conflict, or build-tool compatibility. Use dependency-tree evidence to identify the chain for every material warning.
4. Change a dependency only when a compatible, maintained replacement exists and explain behavior/build risks. State clearly when a warning is resolvable only upstream. Never use flags that hide warnings or weaken peer/security checks merely for clean output.
5. After approved changes, re-run clean install, lint, test, build, and package commands from their exact directories. Compare generated outputs and lockfile changes; report failures without claiming the replacement is safe until validated.

## Output

Return environment evidence, command log with directories, warning-to-chain table, actionable versus upstream findings, minimal compatible remediation, post-change validation, and unresolved risk.
