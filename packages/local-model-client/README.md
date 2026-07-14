# `@local-agent-lab/local-model-client`

Provider-neutral, structured local-model access for the laboratory. The only production provider is LM Studio; `MockModelClient` is an explicit deterministic test provider.

## Transport selection

- `LM_STUDIO_BASE_URL` is an HTTP control-plane URL and defaults to `http://127.0.0.1:1234`. Only `127.0.0.1`, `localhost`, and `::1` are accepted; the package canonicalizes them to `127.0.0.1` and rejects credentials, paths, query strings, fragments, LAN addresses, and linked-device IP addresses.
- Without `LM_STUDIO_API_TOKEN`, inference uses `@lmstudio/sdk@1.5.0`. The package derives `ws://127.0.0.1:<port>` for the SDK, loads with a bounded context length, and requests Zod-structured output with finite output tokens.
- With `LM_STUDIO_API_TOKEN`, inference uses authenticated localhost `fetch`: native `/api/v1/models`, `/api/v1/models/load`, and `/v1/chat/completions` with JSON Schema. The token never appears in errors or diagnostic output. LM Studio 0.4.0 or newer is required for this native API path.

Every final result is independently validated with Zod. Connection, resolution, load, prediction, transport retries, and malformed-output repairs are independently bounded. Interrupted or partial structured generations are discarded.

## Model resolution

Use the exact logical key shown by `npm run models:lmstudio`. Exact keys win. Exact physical variant IDs are also accepted. Normalized display-name matching is allowed only when it resolves to one logical key. Physical local and LM Link variants sharing the same key are collapsed, so they do not create false ambiguity.

LM Studio owns device routing. A successful inference does not prove that the preferred linked device performed it; confirm the active device and preferred-device setting in LM Studio.

## Configuration

Configuration factories read explicit values before environment values before conservative defaults. Supported environment values are:

- `LM_STUDIO_BASE_URL`, `LM_STUDIO_MODEL`, `LM_STUDIO_API_TOKEN`
- `MODEL_CONTEXT_TOKENS`, `MODEL_TEMPERATURE`, `MODEL_MAX_OUTPUT_TOKENS`
- `MODEL_CONNECTION_TIMEOUT_MS`, `MODEL_RESOLUTION_TIMEOUT_MS`, `MODEL_LOAD_TIMEOUT_MS`, `MODEL_REQUEST_TIMEOUT_MS`
  (`MODEL_PREDICTION_TIMEOUT_MS` remains a lower-precedence compatibility alias)
- `MODEL_MAX_RETRIES` (maximum `2`) and `MODEL_RETRY_DELAY_MS`

An LM Studio API token protects the local API. It is not an LM Studio account password, an LM Link login, or an OpenAI API key. This package contains no OpenAI or Ollama provider and performs no cloud fallback.
