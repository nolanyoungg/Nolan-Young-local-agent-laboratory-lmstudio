# Release Engineer

Release Engineer is the laboratory's deterministic, local release-readiness application. It validates one confined Node workspace, optionally proposes or applies bounded repairs, builds a reproducible ZIP under the trusted run directory, streams the archive back through a defensive inspector, hashes it, and writes factual release notes. It never publishes, tags, commits, pushes, or creates a hosted release.

## Commands

```powershell
npm run release-engineer -- check --workspace examples/sample-release-project
npm run release-engineer -- prepare --workspace examples/sample-release-project --mode dry-run
npm run release-engineer -- package --workspace examples/sample-release-project --mode apply
npm run release-engineer -- release --workspace examples/sample-release-project --mode apply
npm run release-engineer -- --help
```

- `check` runs deterministic validation only and never requires or contacts a model.
- `prepare` validates and, only with `--repair`, may run up to three repair passes.
- `package` requires passing checks, creates a sorted ZIP in apply mode, and validates every streamed entry against the manifest.
- `release` composes validation/optional repair, packaging, inspection, SHA-256 generation, and factual notes.

The safe default is `--mode dry-run`. Dry-run validates the virtual manifest and writes reports, but emits no ZIP or checksum and does not modify the target workspace. `--dry-run` is an alias for `--mode dry-run`; a conflicting apply selection is a usage error.

## Deterministic authority

The trusted `config/checks.json` policy requires valid package `name` and semantic `version` fields plus the expected release files. Deny patterns override package include patterns. Secrets, VCS data, dependencies, caches, reports, existing archives, certificates, and private-key material are excluded. Any symlink, junction, non-regular entry, traversal, case-folded duplicate, manifest mismatch, forbidden ZIP entry, or hash mismatch rejects the package.

ZIP entries use normalized POSIX paths, a fixed timestamp, normalized regular-file mode, deterministic order, and stored (uncompressed) bytes. Inspection is lazy and streaming. Checksums cover the fully validated ZIP.

Default policies are loaded only from this application's `config` directory. Operators can explicitly select trusted alternatives with `--check-policy` and `--package-policy`; no policy is auto-loaded from the target workspace. Repair tools cannot access the active policy files and have no delete, shell, process, Git, or publishing capability.

## Repair and local inference

Repair is opt-in:

```powershell
npm run release-engineer -- prepare --workspace C:\work\package --repair --mode dry-run
npm run release-engineer -- release --workspace C:\work\package --repair --mode apply --model openai/gpt-oss-20b
```

`lmstudio` is the default explicit repair provider. `--provider mock` selects deterministic scripted mock behavior for tests; mock is never an automatic fallback. Passing deterministic checks skip inference even when repair was permitted. The application loads only the laboratory root's optional `.env`, never a target workspace's `.env`.

## Run output

Every invocation acquires an exclusive workspace lock under the trusted report root and creates a run directory named `YYYYMMDDTHHMMSSmmmZ-release-engineer-<uuid>`. The directory contains metadata-only `trace.jsonl`, sanitized common metadata/diagnostics/final result, the application-owned `final-report.md`, deterministic check results, and (when applicable) a package manifest, archive inspection, release notes, ZIP, and checksum. `mutation-journal.json` is always present: it is empty for model-free runs and records only successful mutation call IDs, tool names, operation fingerprints, relative paths, before/after hashes, and dry-run state for repair runs.

The report root must be outside the target workspace. Trace events contain identifiers, status, counts, sizes, hashes, and durations—never prompts, model responses, file contents, authorization data, tokens, whole environments, or raw logs.

Exit codes are `0` for success/help, `1` for a completed workflow failure, `2` for usage/configuration/security errors, `3` for model or infrastructure failure, and `130` for interruption.
