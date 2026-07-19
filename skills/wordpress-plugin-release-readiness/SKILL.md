# WordPress Plugin Release Readiness

## Trigger

Use to prepare a custom WordPress plugin for release, deployment, activation, or ZIP packaging. Do not use for a theme release or a runtime penetration test.

## Constraints and workflow

Require exact plugin and optional ZIP paths. Start read-only; preserve unrelated files; never require a full WordPress installation for static checks. Parse main-plugin headers/identity; inventory PHP/assets/build output/translations/uninstall files; lint relevant PHP with `php -l` when available; and inspect package entries for one intended plugin root and accidental development dependencies/secrets/reports.

Trace activation/deactivation hooks, migrations, capabilities, nonces, direct-access guards, AJAX actions, REST routes and `permission_callback`, enqueue paths, and uninstall behavior. Treat missing capability/nonce checks, unsafe endpoint access, unsafe direct invocation, or unexpectedly destructive uninstall paths as security-sensitive confirmed findings when source evidence supports them. Separate required behavior, optional good practice, static evidence, runtime checks requiring WordPress, failures, warnings, and blocked checks. Do not claim activation, migrations, permissions, or uninstall behavior was proven without a suitable runtime test.

## Output

Return identity, scope/files checked, lint results, endpoint/security evidence, migration and uninstall assessment, translation/assets/package results, confirmed failures, warnings, blocked/runtime checks, exact minimal remediation, and `PASS`, `WARN`, `FAIL`, or `BLOCKED` status.
