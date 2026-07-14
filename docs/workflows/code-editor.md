# Code Editor workflow

`plan-only` runs the read-only planner, writes the plan and an empty proposed diff, and marks editing/review skipped. `dry-run` runs planner, editor, and reviewer against a virtual overlay for up to three repair passes. `apply` performs atomic file-level writes, then reviews the resulting workspace and may make bounded repairs. It does not commit, push, or silently roll back independent successful edits.

Required inputs are `--workspace` and `--task`. `--mode` is canonical; `--dry-run` aliases `--mode dry-run` and conflicts are usage errors.
