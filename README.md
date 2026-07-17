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

To audit the library's agent and skill definitions:

```powershell
npm run agent -- --agent agent-definition-auditor --workspace C:\work\local-agent-library --task "Audit agent and skill definitions for loader compatibility and read-only safety"
```

The theme verifier combines deterministic checks with an evidence-limited LM Studio or LM Link assessment. It checks local WordPress structure, headers, local asset references, and PHP syntax, then sends only those verification results to the configured model. Optional flags are `--lmstudio-url`, `--model`, `--skill`, `--max-steps`, and `--report-directory`. A run writes `report.md`, validated `result.json`, `run-metadata.json`, and sanitized `trace.jsonl` below `reports/agent-runs/` by default.

## Safety boundaries

Agents can only list files, read text files, read metadata, and search text inside the selected canonical workspace. The guard blocks traversal, symlink escapes, `.git`, environment files, keys, dependency folders, lock files, and reports. Images and fonts must be inspected through metadata. Model turns use JSON Schema structured output and strict action validation; unsupported tools, prose tool impersonation, repeated calls, invalid evidence, and premature completion are rejected.

To add an agent, create `agents/<id>/AGENT.md` with its ID, default skills, the four allowed tools, and a step limit. To add a skill, create `skills/<id>/SKILL.md` and a small checklist reference if useful. `agents/openai.yaml` is compatibility metadata only and does not invoke an OpenAI-hosted model.

Implementation references: [LM Link](https://lmstudio.ai/docs/lmlink), [LM Studio Developer Docs](https://lmstudio.ai/docs/developer), [model listing](https://lmstudio.ai/docs/developer/openai-compat/models), [structured output](https://lmstudio.ai/docs/developer/openai-compat/structured-output), and [tool use](https://lmstudio.ai/docs/developer/openai-compat/tools).
