# Getting Started

## 1. Install prerequisites

Install Node.js 24 LTS and npm 11 on the controller machine. Install current LM Studio locally. If linked-device inference is desired, install LM Studio or `llmster` on the desired inference device and complete [LM Link setup](lm-link-setup.md).

## 2. Install and validate

```bash
npm ci
npm run validate
```

The intentionally broken example is not an npm workspace and cannot fail root validation.

## 3. Inspect visible models

Start the local LM Studio server on the controller machine, bound to localhost, then run:

```bash
npm run models:lmstudio
npm run check:lmstudio
npm run check:lmlink
```

Set `LM_STUDIO_MODEL` to an exact key printed by the model-list command.

## 4. Run an application

```bash
npm run code-editor -- --workspace ./examples/broken-typescript-project --task "Add robust numeric input validation" --mode dry-run
npm run build-assistant -- --workspace ./examples/broken-typescript-project --command build --mode dry-run --mock
npm run release-engineer -- check --workspace ./examples/sample-release-project
```

Every workflow writes a unique directory beneath `reports/runs`. Reports are allowed in every mode; dry-run only forbids target and release-artifact mutation.
