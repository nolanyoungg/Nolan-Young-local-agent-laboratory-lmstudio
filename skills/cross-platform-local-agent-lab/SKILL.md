# Cross-Platform Local Agent Lab

## Trigger

Use to operate, diagnose, or validate local coding-agent workflows across Windows and macOS with LM Studio, LM Link, Ollama, or an approved OpenAI-compatible local endpoint. Do not use to change global machine configuration or manage a cloud API.

## Constraints

Detect OS and installed tools read-only. Preserve OS parity: use platform-specific commands only where unavoidable and describe an equivalent. Do not reveal API keys/tokens/private environment values, widen workspace access, or make destructive global changes. This repository natively consumes LM Studio/LM Link compatible endpoints; treat other servers as external endpoints to validate, not as a reason to alter its architecture.

## Test ladder

1. Connection: verify endpoint scheme, reachability, TLS/loopback policy, and authentication presence without printing secrets.
2. Model list: query supported models and confirm the selected model identity.
3. Minimal completion: issue a harmless deterministic prompt and record latency/timeout class.
4. Filesystem boundary: confirm an agent can access only the intended canonical workspace and rejects traversal/sensitive paths.
5. Tool invocation: run a safe listed/read action and record unavailable-tool failures distinctly.
6. Small code review: run the same bounded request through Windows-to-macOS or macOS-to-Windows path where available.
7. Failure report: classify endpoint, authentication, model, timeout/resource, connectivity, and tool-availability failures separately.

## Output

Include OS/tool inventory, endpoint/model evidence, workspace boundary result, ladder results, exact safe commands and working directories, cross-device parity result, and minimal next action. Mark a remote-device test blocked when LM Link or an approved remote endpoint is absent.
