# Build Assistant

Runs exactly one trusted symbolic command, diagnoses failures, proposes or applies bounded repairs, and rechecks for at most three passes. A target workspace never supplies the command map and the model never supplies an executable, argument, working directory, or environment name.

```powershell
npm run build-assistant -- --workspace examples/broken-typescript-project --command build --mode dry-run --mock
```

`--mode apply` changes files; `--mode dry-run` uses the overlay and reports **repair proposed, verification not executed**. Watcher commands use trusted ready/success/failure patterns and the process is terminated on every exit path.

## Command policy

The default laboratory-owned map is `config/commands.example.json`. An operator may explicitly select another regular JSON file with `--commands-file`; it is never discovered in the target workspace. Entries support only `kind: "npm"` or `kind: "node"`. Both launch through the current Node executable with `shell: false`; npm additionally requires a validated absolute `npm-cli.js`.

Watcher patterns are case-insensitive literal strings, not regular expressions. One watcher is started for the whole run, bounded log deltas are supplied to agents, and the process tree is terminated in `finally`, including interruption and model failure paths.

## Reports and exits

Every run writes `final-report.md`, a sanitized mutation journal, build attempts, bounded sanitized process logs, process-log metadata, diagnostics, and the common JSONL trace. The JSONL trace contains metadata only—never prompts, responses, file contents, authorization data, or raw logs.

Exit codes are `0` for success/help, `1` for an unresolved workflow or unverified dry-run repair, `2` for usage/configuration, `3` for model/process infrastructure, and `130` for interruption.
