# WordPress Asset Build Integrity

## Trigger

Use to trace WordPress theme source assets through Gulp, Webpack, Vite, Sass/SCSS, JavaScript/TypeScript, and packaging into files actually enqueued and browser-loaded. Start read-only. Do not use for general PHP behavior or a full release assessment.

## Workflow

1. Require the exact theme path and target environment/package. Inventory source entries, build configuration, package scripts, generated directories, source maps, fonts, and static assets.
2. Map `source entry -> build config/script -> generated output -> enqueue handle/path -> template reference -> browser request`. Resolve child-theme versus parent-theme URI usage separately.
3. Compare expected build outputs with files present and with `functions.php`/enqueue references. Flag missing/stale/mismatched outputs, missing fonts/source-map dependencies, and dynamic/runtime-only references using the appropriate certainty.
4. Inspect production ZIP rules for development-only assets accidentally included and required compiled assets excluded. Do not delete files or run a build without confirmation.
5. Verify with a safe build when available, WordPress rendering when an environment exists, browser network requests, and package contents. Static inspection cannot prove browser execution.

## Output

Provide a concise source-to-browser map, missing/stale/mismatched evidence, child/parent path findings, build/package checklist, exact commands and working directories, remediation, and confirmed versus unverified results.
