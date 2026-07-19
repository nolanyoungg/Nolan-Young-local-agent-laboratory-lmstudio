# WordPress Theme Release Readiness

## Trigger

Use when preparing a standalone classic, block, hybrid, or child WordPress theme for packaging, upload, activation, or release. Do not use for a broad code-quality review; use `wordpress-theme-file-review` for its deterministic static review and `wordpress-asset-build-integrity` for a build-only investigation.

## Inputs and constraints

Require the exact absolute theme path and, if packaging is requested, the exact ZIP path or staging directory. Preserve unrelated changes. Start read-only and work in the stated directory. A floating theme folder is sufficient: never require WordPress core, `wp-content`, plugins, a database, or a running server. Do not delete, zip, upload, or overwrite anything without explicit confirmation.

## Workflow

1. Inventory the root. Parse root `style.css`; require a non-empty `Theme Name`. Detect child themes from `Template`, block themes from `templates/*.html` (especially `templates/index.html`), classic themes from PHP templates, and hybrid themes from both. For a child theme, confirm `Template` is a plausible parent directory name; report a missing supplied parent as unverifiable, not missing.
2. Check the architecture-appropriate structure. Parse `theme.json` when present and report malformed JSON as a failure; do not claim it is required for every theme. Inventory template, part, pattern, stylesheet, script, font, image, and build-output files.
3. Run `php -l` on every relevant theme PHP file when PHP is available; record each exact command, working directory, file count, failures, and unavailable-tool state. Never execute theme PHP.
4. Statically trace resolvable local `get_template_directory_uri`, `get_stylesheet_directory_uri`, enqueue, HTML, CSS, and template references. Classify missing local targets as failures; dynamic, WordPress-core, parent-theme, plugin, CDN, or runtime references as warnings or unverifiable evidence.
5. Inspect package rules and the ZIP, if supplied or explicitly created. Confirm its entries are under exactly one intended top-level theme directory and flag source/dependency, cache, secret, report, editor, or development artifacts according to the declared release policy. A ZIP is not proof of activation or rendering.
6. Recommend the smallest remediation only for confirmed evidence. Run a relevant read-only recheck after approved corrections.

## Report

Return `PASS`, `WARN`, `FAIL`, or `BLOCKED` with: theme identity and architecture; exact files/checks performed; PHP lint results; build-output and asset-reference results; ZIP/package contents; confirmed failures; warnings; blocked or unverifiable checks; exact minimal remediation; and the evidence/inference boundary. `FAIL` requires a confirmed release-blocking defect; `BLOCKED` means a required requested check could not run; `WARN` is non-blocking or static-only evidence.
