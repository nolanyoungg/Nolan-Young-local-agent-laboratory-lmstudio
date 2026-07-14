# Security Model

The model is untrusted reasoning input. Prompts are guidance, not a security boundary.

## Enforced boundaries

- One canonical workspace root is selected and exclusively locked per run.
- Model paths are relative-only and checked for traversal, absolute/UNC/device syntax, forbidden globs, excessive length, and symlink or junction traversal.
- Reads and writes use separate deny-overrides-allow policies.
- Secret-oriented paths, VCS data, dependencies, caches, reports, credentials, keys, and certificates are denied.
- Text size, search result, file count, process log, agent step, context, retry, and repair limits are deterministic.
- Mutations require an observed hash or confirmed absence and use atomic file replacement.
- No deletion tool exists.
- Process definitions are trusted application policy. The model selects no executable, argument, cwd, environment variable, or raw command.
- Tool calls are deduplicated by call ID and canonical mutation fingerprint.
- Traces contain metadata and redacted errors, not prompts, responses, file bodies, tokens, headers, or complete environments.

## Threat model

The model, requested paths, and pre-existing workspace layout are hostile. The logged-in local user and operating system are trusted. A malicious same-account process racing a checked path can create a time-of-check/time-of-use condition that portable Node.js cannot eliminate fully on Windows. The guard rechecks immediately before mutation, rejects reparse traversal, and locks cooperating workflows, but it is not a Windows kernel sandbox.

Similarly, process-tree cleanup handles normal completion, errors, timeouts, and Ctrl+C; it cannot guarantee cleanup after power loss or forced operating-system termination.

Do not use a workspace containing secrets in ordinary source files. Filename policies are a safety boundary, not a general data-loss-prevention engine.
