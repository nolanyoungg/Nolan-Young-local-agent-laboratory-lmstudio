# WordPress Theme Production Factory

## Trigger and boundary

Use for substantial, persistent WordPress theme implementation: build an approved specification into an original production-minded theme, or harden and complete an existing theme across many resumable work sessions. Use for classic, block, child, or hybrid themes only after architecture discovery. Do not use for a narrow static review, data-flow diagnosis, or release-only check; use `wordpress-theme-file-review`, `wordpress-hook-data-flow`, `wordpress-asset-build-integrity`, and `wordpress-theme-release-readiness` for those focused tasks. Do not attach this skill to the repository's read-only agents: it requires approved write access to the target theme.

## Scope, safety, and durable artifacts

Require: the exact approved target theme directory; approved documentation directory; requirements/design sources; target WordPress/PHP versions; package destination; and whether a local WordPress/browser environment exists. Start with read-only discovery. Never edit outside the target theme, except approved repository registration/tests/docs. If no documentation directory is approved, use `<theme>/docs/production-factory/` only after confirming it is in scope.

Create and maintain these durable artifacts before implementation, using [checkpoint artifacts](references/checkpoint-artifacts.md): `implementation-plan.md`, `requirements-matrix.md`, `progress-log.md`, and `release-readiness-report.md`. Update the progress log after every completed phase with files changed, commands/results, failures, assumptions, remaining work, and the next resumable phase. Preserve unrelated/user-owned work. Never idle to satisfy a duration; continue until a genuine terminal condition, an approval boundary, or an honest blocker.

Never delete user work, run destructive Git commands, install/update dependencies without a recorded need and approval, push/deploy/upload/publish/merge/open a PR, or claim unavailable tooling/runtime behavior passed. Do not silently change a classic theme into a block theme or conversely.

## Phase 1 — discovery and requirements

Inventory the target and relevant project documents, references, screenshots, pages, and build/deployment conventions. Identify new versus existing, standalone versus child/full WordPress context, theme architecture, user-owned files, WordPress/PHP compatibility, build scripts, lint/test/package conventions, required pages/templates/components/menus/forms/blocks/widgets/integrations, production package format, quality requirements, and explicit exclusions.

Normalize evidence into a requirement matrix. Give every requirement an ID, source, implementation location, validation method, status, and assumptions. Do not create speculative product features; record only safe technical assumptions.

## Phase 2 — architecture checkpoint

Before broad edits, record root structure, PHP/bootstrap architecture, template hierarchy and parts, asset/build/CSS/JS approach, hooks/enqueues, configuration dependencies, accessibility and i18n strategies, packaging, validation, and rollback/recovery. Preserve established naming and architecture in existing themes unless a documented defect requires targeted change. Validate the plan against the detected architecture and leave the repository coherent before phase completion.

## Phase 3 — core vertical slices

Implement one functional slice at a time and checkpoint after each: valid `style.css`; bootstrap and `functions.php`; asset registration/enqueue; required templates; header/footer/navigation/responsiveness; content and error/empty templates; reusable parts; supports; and architecture-appropriate editor compatibility. Escape/sanitize output and input, use capability and nonce checks for custom actions, and make all user-visible strings translation-ready. Keep plugin responsibilities out of the theme unless explicitly approved. Do not represent placeholders, mock integrations, payment flows, APIs, or untested dynamic behavior as complete.

## Phase 4 — approved features

For each approved ACF, forms, WooCommerce, responsive-menu, search, template, settings, newsletter, UTM, accessibility, or SEO feature: map input/configuration -> PHP/hooks -> templates/assets -> browser output; identify all consumers; implement minimally; add focused tests or verification; and check adjacent templates, responsive behavior, and package contents. Use `wordpress-hook-data-flow` or `woocommerce-variation-data-flow` when the feature crosses those boundaries.

## Phase 5 — continuous quality

At every meaningful checkpoint, run available relevant checks from the exact working directory: PHP lint on relevant PHP files; JSON/`theme.json`; manifests/build config; project lint/typecheck/tests; local template/asset/build-output references; hierarchy/child relationship; unsafe direct access, unescaped output, unsafe request handling, missing nonces/capabilities; browser console/network/responsive behavior when a preview exists; and production versus development package contents. Record each command and result. Do not suppress warnings or weaken checks.

## Phase 6 — hardening and release

Reconcile every requirement as complete, deferred, blocked, or failed. Remove only approved unused/development artifacts. Confirm metadata, required templates/assets, lint, compiled enqueued CSS/JS, and ZIP contents. A final ZIP must contain exactly one installable theme root. Complete setup/build/test/package/deploy instructions in the approved documentation location, run the relevant repository suite, and use `wordpress-theme-release-readiness` for an evidence-limited release assessment.

## Resume protocol

On resumption, read the progress log and requirement matrix first; verify repository state and artifact claims; continue at the next valid phase without redoing completed work unless evidence shows it incomplete, broken, or obsolete. Follow [evaluation prompts](references/evaluation-prompts.md) to test new-classic, existing-classic, interrupted-resume, missing-build-output, package, scope-boundary, and unavailable-tool paths.

## Final Report

Return the final requirement matrix; complete file created/changed/removed list; architecture summary; final progress log; commands and results; warnings/blocked checks/deferrals; exact build/package commands and working directories; final ZIP location/name; deployment checklist; and `READY`, `READY WITH WARNINGS`, `NOT READY`, or `BLOCKED`. `READY` requires all material requirements and checks complete; static validation is not a production guarantee.
