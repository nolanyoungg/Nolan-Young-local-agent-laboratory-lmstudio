# Local Agent Library for LM Studio

This repository is a small, read-only AI-agent and skill library for models served by LM Studio. It uses LM Studio's documented OpenAI-compatible HTTP API only; no cloud provider or Ollama compatibility layer is included.

- A **model** is loaded and served by LM Studio.
- An **agent** is a role definition in `agents/` with a constrained read-only tool set.
- A **skill** is reusable review guidance in `skills/`.

## Configure LM Studio or LM Link

Start the server in LM Studio's Developer tab or with `lms server start`. For local development use `http://127.0.0.1:1234/v1`. LM Link can securely expose a model running on another device; this library consumes the URL you configure and does not create, administer, or reconfigure LM Link/Tailscale connections. HTTP is allowed only for loopback; remote endpoints must be HTTPS. Never place credentials in a URL.

Copy `.env.example` to `.env` and set `LMSTUDIO_BASE_URL`, `LMSTUDIO_MODEL`, and, only when authentication is enabled in LM Studio, `LMSTUDIO_API_TOKEN`. Tokens are sent as Bearer authentication and are redacted from reports and errors.

```powershell
npm run check:lmstudio
npm run agent:list
npm run agent -- --agent github-repo-review --workspace C:\work\repo --task "Review structure, tests, and documentation" --lmstudio-url http://127.0.0.1:1234/v1 --model openai/gpt-oss-20b
```

For a WordPress theme:

```powershell
npm run agent -- --agent wordpress-theme-verification-agent --workspace C:\work\theme --task "Verify this theme"
```

For a deterministic complete file review of one theme or a directory of immediate-child themes (no LM Studio model is required):

```powershell
npm run agent -- --agent wordpress-theme-file-reviewer-agent --workspace C:\work\themes --task "Audit WordPress theme files"
```

This writes a readable `report.md` plus a versioned, machine-readable `result.json`. It inventories every file, runs `php -l` only when PHP is available, parses safe local formats, and reports statically resolvable local references. It never executes theme code, JavaScript, builds, WordPress, or a browser. Its local rules are based on the current official [Theme Handbook](https://developer.wordpress.org/themes/), [theme structure](https://developer.wordpress.org/themes/core-concepts/theme-structure/), [main stylesheet](https://developer.wordpress.org/themes/core-concepts/main-stylesheet/), [templates](https://developer.wordpress.org/themes/core-concepts/templates/), [theme.json](https://developer.wordpress.org/themes/core-concepts/global-settings-and-styles/), [child themes](https://developer.wordpress.org/themes/advanced-topics/child-themes/), [security](https://developer.wordpress.org/themes/advanced-topics/security/), [testing](https://developer.wordpress.org/themes/advanced-topics/testing/), and [PHP standards](https://developer.wordpress.org/coding-standards/wordpress-coding-standards/php/).

To audit the library's agent and skill definitions:

```powershell
npm run agent -- --agent agent-definition-auditor --workspace C:\work\local-agent-library --task "Audit agent and skill definitions for loader compatibility and read-only safety"
```

The theme verifier combines deterministic checks with an evidence-limited LM Studio or LM Link assessment. It checks local WordPress structure, headers, local asset references, and PHP syntax, then sends only those verification results to the configured model. Optional flags are `--lmstudio-url`, `--model`, `--skill`, `--max-steps`, and `--report-directory`. A run writes `report.md`, validated `result.json`, `run-metadata.json`, and sanitized `trace.jsonl` below `reports/agent-runs/` by default.

## Safety boundaries

Agents can only list files, read text files, read metadata, and search text inside the selected canonical workspace. The guard blocks traversal, symlink escapes, `.git`, environment files, keys, dependency folders, lock files, and reports. Images and fonts must be inspected through metadata. Model turns use JSON Schema structured output and strict action validation; unsupported tools, prose tool impersonation, repeated calls, invalid evidence, and premature completion are rejected.

To add an agent, create `agents/<id>/AGENT.md` with its ID, default skills, the four allowed tools, and a step limit. To add a skill, create `skills/<id>/SKILL.md` and a small checklist reference if useful. `agents/openai.yaml` is compatibility metadata only and does not invoke an OpenAI-hosted model.

Implementation references: [LM Link](https://lmstudio.ai/docs/lmlink), [LM Studio Developer Docs](https://lmstudio.ai/docs/developer), [model listing](https://lmstudio.ai/docs/developer/openai-compat/models), [structured output](https://lmstudio.ai/docs/developer/openai-compat/structured-output), and [tool use](https://lmstudio.ai/docs/developer/openai-compat/tools).

## CI checks

GitHub Actions runs the complete deterministic quality gate on Ubuntu: repository and workflow-operation verification, formatting, linting, type-checking, tests, and build. A dependent Windows job then repeats installation, structural workflow checks, tests, and build to catch platform-specific path or process behavior without duplicating every static check. `npm run verify:github-operations` keeps the checked-in CI contract aligned with these safe, locked-dependency operations.
