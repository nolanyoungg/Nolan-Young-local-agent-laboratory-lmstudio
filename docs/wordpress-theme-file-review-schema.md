# WordPress Theme File Review Report Schema

`agents/wordpress-theme-file-reviewer-agent/workflow.ts` owns the versioned JSON report schema. The current `schemaVersion` is `1.0.0`; consumers must reject unknown major versions.

Top-level fields are `schemaVersion`, `executionTime`, `target`, `inputClassification`, `tools`, `nonThemeDirectories`, `themes`, `findings`, and `scope`. `inputClassification` is `SINGLE_THEME_ROOT`, `THEME_COLLECTION_ROOT`, or `INVALID_TARGET`.

Each `themes` entry contains `root`, `name`, `status`, `type`, parsed `metadata`, a complete `manifest`, `references`, `phpLint`, and theme `findings`. Every manifest entry has the relative `path`, `extension`, class `type`, byte `size`, analysis state, result, and checks applied. Reference entries retain source path/line, target, and resolution category.

Finding statuses are `PASS`, `WARN`, `FAIL`, `INFO`, `BLOCKED`, `UNVERIFIED`, and `SKIPPED`. A `FAIL` is only a confirmed recognition, syntax, parse, or missing-local-file failure. `WARN` findings based on patterns carry `staticInference: true`; parent, plugin, core, and runtime dependencies are not presented as missing local files.
