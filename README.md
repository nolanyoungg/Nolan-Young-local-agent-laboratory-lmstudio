# Nolan Young Local Agent Laboratory — LM Studio Edition

Run carefully constrained, local AI-assisted engineering workflows from one
Node.js/TypeScript repository. The laboratory has three applications:

| Application          | Use it for                                                                       | Can change files?    |
| -------------------- | -------------------------------------------------------------------------------- | -------------------- |
| **Code Editor**      | Planning, reviewing, and making a narrowly scoped code change                    | Only in `apply` mode |
| **Build Assistant**  | Investigating an approved build command and repairing its source-level cause     | Only in `apply` mode |
| **Release Engineer** | Checking a Node release candidate, preparing it, and creating a reproducible ZIP | Only in `apply` mode |

Inference is local through LM Studio. This project does **not** use an OpenAI
API key, the OpenAI SDK, Ollama, a cloud fallback, SSH, Git automation, or a
remote filesystem. It talks to the controller machine's local LM Studio control
plane at `http://127.0.0.1:1234`. That loopback server is the **LM Link entry
point**: when a linked device is connected and selected as preferred, LM Studio
forwards inference to that device's loaded model. The controller machine keeps
the workspace, tools, locks, and reports; the preferred linked device performs
model inference.

> [!IMPORTANT]
> The command-line applications deliberately reject LAN, remote, and linked-device IP
> addresses. Even if LM Studio's Developer screen advertises a LAN URL, use
> `http://127.0.0.1:1234` with this repository. That restriction keeps model
> traffic local to the controller machine and prevents accidental workspace or
> credential exposure on the network.

## Contents

- [What you need](#what-you-need)
- [Get a copy on Windows](#get-a-copy-on-windows)
- [Get a copy on macOS](#get-a-copy-on-macos)
- [Configure LM Studio](#configure-lm-studio)
- [First-run checklist](#first-run-checklist)
- [How the agents and skills work](#how-the-agents-and-skills-work)
- [Choose and run an agent](#choose-and-run-an-agent)
- [Read reports and exit codes](#read-reports-and-exit-codes)
- [Safety boundaries and limitations](#safety-boundaries-and-limitations)
- [Configuration reference](#configuration-reference)
- [Development and validation](#development-and-validation)
- [Troubleshooting](#troubleshooting)
- [End-to-end operator playbook](#end-to-end-operator-playbook)
- [How to judge a completed run](#how-to-judge-a-completed-run)

## What you need

### Required on the controller machine

- **Node.js 24 LTS** and npm 11 or later. The repository enforces Node `>=24 <25`.
- **Git** for cloning and updating the repository.
- **LM Studio 0.4.0 or newer** if you will run a live model.
- A loaded, tool-capable local model. The documented default is
  `openai/gpt-oss-20b`, but the exact identifier visible in your LM Studio
  installation is the source of truth.

### Optional linked inference device

- LM Studio or `llmster`, configured with **LM Link**.
- A model compatible with the controller-selected logical model key.
- The controller machine must still use its own loopback URL. Do not substitute
  a linked-device address or an LM Link address into `LM_STUDIO_BASE_URL`.

An inference peer is not a target workspace. This project never grants the
model remote shell, remote file, SSH, or direct network access.

## Get a copy on Windows

Open **PowerShell** and use a normal development directory. These commands
create a fresh clone, select Node 24 when you use nvm-windows, install the
locked dependency tree, and validate the repository.

```powershell
mkdir $HOME\Developer\repos -Force
Set-Location $HOME\Developer\repos
git clone https://github.com/nolanyoungg/Nolan-Young-local-agent-laboratory-lmstudio.git
Set-Location .\Nolan-Young-local-agent-laboratory-lmstudio

# Optional when nvm-windows is installed; otherwise confirm `node --version` is v24.x.
nvm use 24

npm ci
npm run validate
```

To update an existing clone without discarding local work:

```powershell
Set-Location $HOME\Developer\repos\Nolan-Young-local-agent-laboratory-lmstudio
git status
git pull --ff-only
npm ci
npm run validate
```

`npm ci` is intentional: it installs exactly the versions in
`package-lock.json`. Do not run agent workflows against this repository itself
unless it is the workspace you explicitly intend to change.

## Get a copy on macOS

macOS can be either a development platform or host an LM Link inference peer. If it
will be an inference peer only, cloning this repository is optional. If you want
to run the commands locally on macOS, use Terminal:

```bash
mkdir -p ~/Developer/repos
cd ~/Developer/repos
git clone https://github.com/nolanyoungg/Nolan-Young-local-agent-laboratory-lmstudio.git
cd Nolan-Young-local-agent-laboratory-lmstudio

# With nvm installed, use the repository's required Node major.
nvm install 24
nvm use 24

npm ci
npm run validate
```

On macOS, a live local run still points at that Mac's own loopback server:

```bash
export LM_STUDIO_BASE_URL=http://127.0.0.1:1234
export LM_STUDIO_MODEL=openai/gpt-oss-20b
npm run check:lmstudio -- --inference
```

For any controller machine with a linked inference device, follow the dedicated
[LM Link setup guide](docs/lm-link-setup.md). Keep the agent process on the
controller and leave its base URL as that machine's loopback address.

## Configure LM Studio

### 1. Start the local server

In LM Studio on the controller, start the local server and load the model you
want to use. The laboratory accepts only this local HTTP control-plane address:

```text
http://127.0.0.1:1234
```

The LM Studio TypeScript SDK needs WebSockets, so the repository derives
`ws://127.0.0.1:1234` internally. You should configure only the HTTP value.

### 2. Discover the exact model key

Never guess a model ID. Ask LM Studio what it sees:

```powershell
npm run models:lmstudio
npm run models:lmstudio -- --json
```

Copy the logical key shown in the output. If local and linked variants have the
same logical key, the laboratory collapses them into one logical model and emits
a routing warning. You may select an exact variant ID when LM Studio exposes one.

### 3. Verify the connection before an agent run

```powershell
npm run check:lmstudio -- --model openai/gpt-oss-20b
npm run check:lmstudio -- --model openai/gpt-oss-20b --inference
npm run check:lmlink -- --model openai/gpt-oss-20b
```

`check:lmstudio -- --inference` performs a short structured completion. It is
the quickest live proof that the selected model can answer. `check:lmlink` also
tries the advisory, read-only `lms link status --json` and `lms ps --json` calls
when they are available; it never changes LM Link settings.

### 4. Optional `.env` overrides

Copy the laboratory's example into the repository root, then edit it locally:

```powershell
Copy-Item .env.example .env
```

```dotenv
LM_STUDIO_BASE_URL=http://127.0.0.1:1234
LM_STUDIO_MODEL=openai/gpt-oss-20b
MODEL_TEMPERATURE=0.1
MODEL_MAX_OUTPUT_TOKENS=4096
```

The root `.env` is optional and ignored by Git. A selected target workspace's
`.env` is never loaded. If `LM_STUDIO_API_TOKEN` is set, this project switches
to LM Studio's authenticated localhost REST transport; it does not install or
use the OpenAI SDK. Do not put an LM Studio account password or an OpenAI key in
this file.

## First-run checklist

Work through these in order. The first four are offline or diagnostic checks;
the last three use explicit mocks and do not require a model.

```powershell
# 1. Confirm the runtime and exact locked dependencies.
node --version
npm ci

# 2. Run all offline quality gates.
npm run validate

# 3. Inspect and diagnose the local model path.
npm run models:lmstudio
npm run check:lmstudio -- --inference
npm run check:lmlink

# 4. Read every CLI's authoritative options.
npm run code-editor -- --help
npm run build-assistant -- --help
npm run release-engineer -- --help

# 5. Safely exercise all applications without a live model or target mutation.
npm run smoke:mock
```

## How the agents and skills work

### Applications, roles, tools, and "skills"

This repository does not give a model an unrestricted autonomous coding skill.
Instead, each application is a fixed workflow made of small, permission-checked
roles. In everyday use, call the **application** that matches the job; its roles
are selected automatically.

| Application      | Built-in roles                                      | What the roles do                                                                          |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Code Editor      | Planner → Editor → Reviewer                         | Inspect, propose/perform bounded edits, then review the resulting workspace or overlay     |
| Build Assistant  | Diagnostician → Repairer → Reviewer                 | Interpret an approved build's bounded logs, repair only through tools, rebuild, and review |
| Release Engineer | Deterministic checks → optional Repairer → Reviewer | Let deterministic checks decide pass/fail; optionally repair, then package and inspect     |

The reusable capabilities sometimes called "skills" are the controlled tools:

- **Read skills:** list files, read valid UTF-8 files, read metadata, and search
  text inside the selected workspace.
- **Edit skills:** create a new file, write a known file with its observed
  SHA-256, or apply a one-file unified diff with its observed SHA-256.
- **Process skill:** Build Assistant can run only an operator-approved symbolic
  command such as `build`; the model cannot provide shell text, executable,
  arguments, working directory, or environment variable names.
- **Release skills:** validate package metadata, make a deterministic ZIP,
  inspect its streamed entries, compute a SHA-256 checksum, and write factual
  release notes. These are deterministic application operations, not model
  permissions.

If you are extending the laboratory, add a tool and its schema deliberately;
see [adding a tool](docs/adding-a-tool.md), [adding an agent](docs/adding-an-agent.md),
and [adding an application](docs/adding-an-application.md). Do not solve a new
need by broadening a prompt or allowing arbitrary shell commands.

### The one-action-per-turn protocol

The live model is allowed to return exactly one of these envelopes per turn:

```json
{
  "kind": "tool_call",
  "callId": "read-index-1",
  "tool": "read_file",
  "input": { "path": "src/index.ts" }
}
```

```json
{
  "kind": "complete",
  "summary": "The requested validation is implemented.",
  "evidence": ["src/index.ts now rejects non-numeric input."],
  "findings": []
}
```

The runtime validates the outer envelope, the exact allowed tool, and the
tool's input schema before anything happens. It rejects unknown tools,
unauthorized calls, malformed input, repeated call IDs with altered input, and
repeated mutations under new call IDs. The model sees bounded results; it never
receives a raw shell, whole environment, secrets, or unrestricted filesystem.

## Choose and run an agent

All examples use a fixture first. Substitute your own absolute or relative
workspace only after confirming it is the intended target. Keep reports outside
the selected workspace.

### 1. Code Editor — scoped source change

Use Code Editor when you have a clear implementation task. It requires
`--workspace` and `--task`.

#### Plan only (safest live inspection)

```powershell
npm run code-editor -- `
  --workspace .\examples\sample-node-project `
  --task "Inspect src/index.js and plan validation for blank names." `
  --mode plan-only `
  --model openai/gpt-oss-20b
```

This runs the Planner only. It creates an empty proposed diff and explicitly
marks editing and review as skipped.

#### Dry run (real workflow, zero target mutation)

```powershell
npm run code-editor -- `
  --workspace .\examples\sample-node-project `
  --task "Make greet use friend for blank or whitespace-only names." `
  --mode dry-run `
  --model openai/gpt-oss-20b
```

The Editor and Reviewer see a virtual overlay. Earlier proposed edits are
visible to later reads, searches, reviews, and patches, but the target files are
unchanged. Inspect the generated `proposed-diff.patch` before using apply.

#### Apply a reviewed change

```powershell
npm run code-editor -- `
  --workspace C:\work\my-app `
  --task "Add an explicit guard for blank display names in src/greet.ts and update its unit test." `
  --mode apply `
  --model openai/gpt-oss-20b `
  --reports-root C:\agent-reports\code-editor
```

Apply uses atomic, file-level writes. It does not delete files, commit, push, or
silently roll back independent edits that already completed. Stop with
`Ctrl+C` to request interruption; exit code `130` is reserved for it.

For an entirely offline workflow demonstration, opt into the deterministic mock:

```powershell
npm run code-editor -- --workspace .\examples\sample-node-project --task "Inspect only" --mode dry-run --mock
```

### 2. Build Assistant — an approved build command

Use Build Assistant when a known build is failing. It requires a symbolic
`--command` from the laboratory-owned command map, not a shell command.

```powershell
# Propose a repair for the intentionally broken fixture. Target files stay unchanged.
npm run build-assistant -- `
  --workspace .\examples\broken-typescript-project `
  --command build `
  --mode dry-run `
  --mock
```

```powershell
# Use live inference after the diagnostic passes.
npm run build-assistant -- `
  --workspace C:\work\my-app `
  --command build `
  --mode apply `
  --model openai/gpt-oss-20b `
  --reports-root C:\agent-reports\build-assistant
```

The default command map is
[apps/build-assistant/config/commands.example.json](apps/build-assistant/config/commands.example.json).
It maps IDs such as `build` to immutable Node/npm argument arrays. To use a
different trusted map, select it explicitly:

```powershell
npm run build-assistant -- --workspace C:\work\my-app --command build --mode dry-run --commands-file C:\operator-config\commands.json
```

The target workspace cannot supply the command map. In dry-run mode the result
is intentionally **"repair proposed, verification not executed"**: the actual
workspace was not changed, so the application will not pretend that it now
builds. Watcher commands, when approved in the map, are started once, observed
using trusted literal patterns, and terminated on every exit path.

### 3. Release Engineer — deterministic release readiness

Use Release Engineer for a Node package directory. Start with `check`, which is
fully deterministic and never calls a model.

```powershell
# Check only: no model and no mutation.
npm run release-engineer -- check --workspace .\examples\sample-release-project

# Prepare a candidate without emitting an archive.
npm run release-engineer -- prepare --workspace .\examples\sample-release-project --mode dry-run

# Create and inspect a reproducible ZIP under the report directory.
npm run release-engineer -- package --workspace .\examples\sample-release-project --mode apply

# Full local release preparation: check, package, checksum, inspection, notes.
npm run release-engineer -- release --workspace .\examples\sample-release-project --mode apply
```

Repair is explicit and only available for `prepare` and `release`:

```powershell
npm run release-engineer -- prepare `
  --workspace C:\work\package `
  --mode dry-run `
  --repair `
  --task "Repair only the deterministic check failures." `
  --provider lmstudio `
  --model openai/gpt-oss-20b
```

Passing deterministic checks are authoritative. The repair role cannot read or
modify the active check or package policy. No Release Engineer action publishes,
tags, commits, pushes, or creates a GitHub release.

## Read reports and exit codes

Each run gets a unique directory under `reports/runs` by default:

```text
reports/runs/
  20260714T130216680Z-code-editor-<uuid>/
    final-report.md
    final-result.json
    model-diagnostics.json
    trace.jsonl
    ...application-specific reports...
```

Code Editor additionally writes its change plan, proposed diff, changed-file
list, mutation metadata, and review report. Build Assistant writes bounded
process-log metadata and build attempts. Release Engineer writes deterministic
check results and, in apply mode, the manifest, archive inspection, ZIP,
checksum, and release notes.

Trace files contain only sanitized metadata: IDs, relative paths, hashes,
sizes, counts, durations, status, and sanitized error codes. They never contain
prompts, model responses, source contents, tokens, authorization data, complete
environments, or raw secret-bearing logs.

| Exit code | Meaning                                     | Typical next step                                                                   |
| --------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `0`       | Success or help text                        | Read the final report and inspect changes/artifacts                                 |
| `1`       | Workflow completed but did not pass         | Review findings; fix manually or run a new scoped attempt                           |
| `2`       | Usage, configuration, or security rejection | Correct flags, model key, paths, or trusted policy                                  |
| `3`       | Model or infrastructure failure             | Run `check:lmstudio`; inspect sanitized diagnostics; do not assume a model fallback |
| `130`     | Interrupted                                 | Inspect reports; the lock and child processes are cleaned up in `finally`           |

## Safety boundaries and limitations

These boundaries are features, not missing convenience:

| Boundary                      | What it means in practice                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| One workspace per run         | Every run canonicalizes and confines itself to the `--workspace` root                                                                       |
| Relative model-facing paths   | Absolute, UNC, device, `..`, NUL-containing, overlong, or excessive-depth paths are rejected                                                |
| No symlink/junction traversal | Existing segments and the nearest parent for creates are checked; Windows case is compared safely                                           |
| Deny overrides allow          | `.git`, `.env*`, `node_modules`, caches, reports, SSH material, credentials, certificates, and private-key extensions are denied by default |
| Bounded file and tool output  | Editable files default to 1 MiB; returned tool output defaults to 128 KiB; listings and searches are capped and report truncation           |
| Optimistic edits              | Create requires absence; write/patch requires the observed SHA-256; patches are one-file unified diffs                                      |
| No model deletion             | There is no delete tool. Only the trusted `npm run clean` maintenance script may remove enumerated generated roots                          |
| No raw model shell            | Build commands are symbolic IDs mapped to trusted executable/argument arrays and run with `shell: false`                                    |
| Bounded processes             | stdout/stderr are capped, model log context is bounded, and descendant processes are terminated on timeout, failure, and interruption       |
| Bounded inference             | Connection, model resolution, loading, and prediction have distinct deadlines; partial responses are discarded                              |
| No automatic fallback         | `--mock` is explicit. A live-model failure remains visible as an infrastructure failure                                                     |

Additional operational limitations:

- A model can propose only one tool call or completion at a time. It cannot make
  arbitrary multi-file changes in one opaque action.
- A dry run is an overlay simulation; it must not be treated as a verified build
  or as a modified target workspace.
- Live structured generation can be slow or fail with a particular model/server
  combination. Keep `MODEL_MAX_OUTPUT_TOKENS` finite, use the diagnostics first,
  and rely on the typed timeout rather than repeatedly submitting requests.
- A successful response is not proof of preferred linked-device execution.
  Confirm routing in LM Studio and configure `lms link set-preferred-device`
  manually if desired.
- The threat model trusts the logged-in local user. Concurrent malicious
  same-account filesystem races and power-loss orphan prevention are residual
  risks; see the [security model](docs/security-model.md).

## Configuration reference

Configuration precedence is: **CLI flag → environment variable → explicitly
selected laboratory-owned configuration → safe default**.

| Variable                      | Default                 | Purpose                                        |
| ----------------------------- | ----------------------- | ---------------------------------------------- |
| `LM_STUDIO_BASE_URL`          | `http://127.0.0.1:1234` | Validated loopback HTTP control-plane URL      |
| `LM_STUDIO_MODEL`             | `openai/gpt-oss-20b`    | Exact or resolvable LM Studio model key        |
| `LM_STUDIO_API_TOKEN`         | unset                   | Enables authenticated localhost REST transport |
| `MODEL_TEMPERATURE`           | `0.1`                   | Sampling temperature                           |
| `MODEL_CONTEXT_TOKENS`        | `32768`                 | Requested loaded-model context length          |
| `MODEL_MAX_OUTPUT_TOKENS`     | `4096`                  | Finite completion cap                          |
| `MODEL_CONNECTION_TIMEOUT_MS` | `15000`                 | Connection deadline                            |
| `MODEL_RESOLUTION_TIMEOUT_MS` | `60000`                 | Model listing/resolution deadline              |
| `MODEL_LOAD_TIMEOUT_MS`       | `300000`                | Model load deadline                            |
| `MODEL_REQUEST_TIMEOUT_MS`    | `300000`                | Prediction deadline                            |
| `MODEL_MAX_RETRIES`           | `2`                     | Maximum model-only retries                     |
| `MODEL_RETRY_DELAY_MS`        | `2000`                  | Delay between eligible model retries           |
| `REPORTS_DIRECTORY`           | `reports/runs`          | Trusted report and lock root                   |

`LM_STUDIO_BASE_URL` must be a credential-free loopback HTTP URL with no path,
query, or fragment. `http://192.168.x.x:1234`, a hostname, a linked-device IP, and a
WebSocket URL are intentionally invalid inputs.

## Development and validation

This is a private npm-workspaces monorepo with exactly three app workspaces and
seven shared package workspaces. Useful commands:

```powershell
npm run format          # Rewrite formatting
npm run format:check    # Verify formatting
npm run lint            # ESLint flat-config checks
npm run typecheck       # Strict TypeScript project references
npm test                # Offline Vitest suite
npm run build           # Compile ESM + declarations
npm run validate        # All of the above plus workspace topology verification
npm run clean           # Remove only enumerated generated roots
```

The CI workflow runs `npm ci` and `npm run validate` on Windows and Ubuntu with
Node 24, explicit mocks, no secrets, and no live model/network dependency.

## Troubleshooting

| Symptom                                     | Check                                                        | Resolution                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `BASE_URL_INVALID` or a URL rejection       | `npm run check:lmstudio -- --base-url http://127.0.0.1:1234` | Use exactly a loopback HTTP URL; do not use the LAN address shown by LM Studio                                  |
| Model is not found                          | `npm run models:lmstudio`                                    | Copy the exact logical key or exact selected variant ID into `--model` / `LM_STUDIO_MODEL`                      |
| Duplicate local and linked models           | `npm run models:lmstudio -- --json`                          | Treat them as one logical key; set LM Link's preferred device manually if routing matters                       |
| Diagnostic inference fails                  | `npm run check:lmstudio -- --inference --json`               | Confirm server/model state, use a finite output cap, and inspect sanitized output; no automatic fallback occurs |
| Agent exits `3`                             | Read `model-diagnostics.json` and `final-result.json`        | Fix LM Studio/model availability or retry only after the server is healthy                                      |
| Build Assistant rejects a command           | Inspect `apps/build-assistant/config/commands.example.json`  | Use a known symbolic ID or explicitly select an operator-controlled command map                                 |
| A dry run did not change files              | Inspect `proposed-diff.patch`                                | This is expected. Re-run with `--mode apply` only after review                                                  |
| Reports conflict with a workspace           | Choose `--reports-root` outside `--workspace`                | Report/lock roots cannot be inside the target workspace                                                         |
| You need linked-device routing confirmation | Review LM Studio's device status and `npm run check:lmlink`  | A successful response is insufficient; confirm it in LM Studio itself                                           |

For more detail, see [LM Studio setup](docs/lm-studio-setup.md),
[LM Link setup](docs/lm-link-setup.md), [device topology](docs/device-topology.md),
[LM Link troubleshooting](docs/troubleshooting-lm-link.md),
[architecture](docs/architecture.md), and the [security model](docs/security-model.md).

## End-to-end operator playbook

This is the recommended sequence for a controller machine plus a linked
inference device. It deliberately separates **connection proof**, **one
scoped edit**, **build proof**, and **release proof**. Each command has a
single responsibility, and each report can be inspected before proceeding.

### A. Confirm the LM Link route, not a LAN connection

Keep the agent on the controller machine and use its loopback address. Do **not** substitute a
linked device's LAN address shown in LM Studio. LM Link is responsible for forwarding
the loopback request to the preferred device.

```powershell
# Both commands are read-only. The first proves peer/preference state; the
# second proves what the controller machine sees as loaded.
lms link status --json
lms ps --json

# Then make one bounded application-level check.
npm run check:lmlink -- --model openai/gpt-oss-20b --json
```

Expected signals are a connected inference peer, that device's identifier as
`preferredDeviceIdentifier`, and an `openai/gpt-oss-20b` entry associated with
that device. A clean diagnostic has a `PASS` inference check. If LM Studio shows
`processingPrompt` while `queued` is zero, stop submitting new requests: cancel
the prompt on the active inference device, then eject and reload the same model if it does not
become idle. Re-run the diagnostic before an apply-mode agent run.

`lms ps` and `lms link status` identify the selected linked device; they do not
prove that any particular token was executed on that device. During a live
test, also observe the active inference device in LM Studio. The laboratory
never changes the preferred device itself. If you need to change it, use LM
Studio or `lms link set-preferred-device` manually and then repeat this section.

> [!WARNING]
> Let a live agent process reach its own configured deadline or interrupt it
> with `Ctrl+C`; do not use an external supervisor with a shorter hard-kill
> timeout. A forced process termination can prevent the SDK cancellation from
> reaching LM Studio, leaving a stale `processingPrompt` request that has no
> usable request ID to cancel. If that happens, wait for it to complete or
> clear it in LM Studio before submitting another model turn.

### B. Edit one file with Code Editor

Use a precise task that says exactly what may change. This example first plans,
then rehearses against the overlay, and only then applies. `v2` is intentionally
in the requested visible change so the result is easy to verify.

```powershell
$lab = "C:\Users\NolanYoung\Developer\repos\Nolan-Young-local-agent-laboratory-lmstudio"
$testRoot = "C:\Users\NolanYoung\Developer\Sandbox\local-agent-tests"
$reports = "C:\Users\NolanYoung\Developer\Sandbox\local-agent-reports\code-editor-v2"

Set-Location $lab

# 1. No target mutation: inspect and write a plan only.
npm run code-editor -- `
  --workspace $testRoot `
  --task "Inspect home.php only. Plan a minimal visible v2 label and one small readability improvement; preserve PHP behavior." `
  --mode plan-only `
  --model openai/gpt-oss-20b `
  --reports-root $reports

# 2. No target mutation: execute editor/reviewer against the overlay.
npm run code-editor -- `
  --workspace $testRoot `
  --task "Edit home.php only. Add a minimal visible v2 label and one small readability improvement. Preserve all PHP behavior and existing links." `
  --mode dry-run `
  --model openai/gpt-oss-20b `
  --reports-root $reports

# Read proposed-diff.patch and review-report.md in the newest run directory.

# 3. Mutate only after the dry-run diff is acceptable.
npm run code-editor -- `
  --workspace $testRoot `
  --task "Edit home.php only. Add a minimal visible v2 label and one small readability improvement. Preserve all PHP behavior and existing links." `
  --mode apply `
  --model openai/gpt-oss-20b `
  --reports-root $reports
```

**What success means:** `final-result.json` has `status: "succeeded"`; the
changed-file report lists only `home.php`; the review report has no unresolved
findings; and the actual file visibly contains the intended `v2` change. Use
`git diff -- C:\Users\NolanYoung\Developer\Sandbox\local-agent-tests\home.php`
or compare the original hash recorded in the report with the new hash. If the
model proposes any other file, reject the run rather than broadening the task.

### C. Build the project with Build Assistant

Build Assistant does not receive a raw command string. `build` is looked up in
the trusted command map, so the model cannot turn this into an arbitrary shell
operation. A clean initial build is a valid success: no repair is necessary,
and no model turn needs to occur.

```powershell
$project = "C:\Users\NolanYoung\Developer\Sandbox\local-agent-tests\nolan-young-theme-template-01"
$buildReports = "C:\Users\NolanYoung\Developer\Sandbox\local-agent-reports\build-assistant-v2"

# Dependency installation is a separate, operator-authorized project action.
Set-Location $project
npm ci

# The application executes only the trusted `build` command ID.
Set-Location $lab
npm run build-assistant -- `
  --workspace $project `
  --command build `
  --mode apply `
  --model openai/gpt-oss-20b `
  --reports-root $buildReports `
  --json
```

**What success means:** `status` and `initialStatus` are `succeeded`,
`finalStatus` is `initial-command-succeeded`, `repairPasses` is `0`, and
`changedFiles` is empty. That is the expected result for a healthy project.
If a build fails, the agent may read only bounded diagnostic log deltas and may
attempt at most three scoped repair/rebuild/review passes. In dry-run, it must
say that verification was not executed—an overlay change never proves the real
workspace now builds.

### D. Review and package a project with Release Engineer

Release Engineer accepts projects, not only Git repositories. It requires a
valid `package.json` name/version and expected release files, but it treats
installed dependencies, source-control data, reports, caches, secrets, and
old archives as excluded development material rather than release contents.

```powershell
$releaseReports = "C:\Users\NolanYoung\Developer\Sandbox\local-agent-reports\release-engineer-v2"

# Deterministic review: no model, no source mutation, no Git requirement.
npm run release-engineer -- check `
  --workspace $project `
  --mode apply `
  --reports-root $releaseReports `
  --json

# Validate exactly what would be packaged without writing a ZIP/checksum.
npm run release-engineer -- package `
  --workspace $project `
  --mode dry-run `
  --reports-root $releaseReports `
  --json

# Only when the manifest is approved, emit a deterministic archive in reports.
npm run release-engineer -- package `
  --workspace $project `
  --mode apply `
  --reports-root $releaseReports
```

**What success means:** `checks.passed` is `true`, findings are empty, and the
reported project name/version match `package.json`. In dry-run, there must be
no ZIP or checksum. In apply mode, the ZIP is created only below the trusted
report root, is inspected after creation, contains deterministic sorted entries,
and includes a SHA-256 checksum. No action publishes, tags, commits, pushes, or
creates a hosted release.

## How to judge a completed run

Use this compact comparison after each agent:

| Agent            | Expected healthy outcome                                            | Evidence to inspect                                                             | Failure that must not be called success                                                          |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Code Editor      | Only requested file(s) changed; reviewer accepts result             | `proposed-diff.patch`, `changed-files.json`, `review-report.md`, real file diff | A plan/dry-run, a timeout, a rejected review, or an edit outside scope                           |
| Build Assistant  | Trusted build exits successfully without repair                     | JSON `initialStatus`, `finalStatus`, `process-log` metadata                     | A proposed overlay repair, unresolved build, watcher crash, or model outage during needed repair |
| Release Engineer | Deterministic policy passes; planned/created archive matches policy | `check-results.json`, manifest, inspection, checksum, final report              | A passing model opinion when deterministic checks still fail                                     |

The final report is a summary, not the only evidence. For an apply-mode source
change, always inspect the actual diff. For a build, inspect the trusted command
status. For a release, inspect the deterministic findings and manifest. This
keeps a fluent model explanation from being mistaken for successful work.

Licensed under the [MIT License](LICENSE).
