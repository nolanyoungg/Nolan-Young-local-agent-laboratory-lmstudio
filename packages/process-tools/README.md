# `@local-agent-lab/process-tools`

Bounded one-shot and watcher process management for the Windows-hosted local
agent applications.

## Trust boundary

Applications construct an immutable `CommandAllowlist` from trusted command
definitions. A model-visible request contains only `{ commandId }`; it cannot
choose an executable, append arguments, change the working directory, inject
environment variables, or request a shell. Executables and working directories
must be absolute, and all children are spawned with `shell: false`.

For npm scripts, `createNpmCommandDefinition()` validates `npm_execpath` as a
real `npm-cli.js` file and invokes it through `process.execPath`. This avoids
shell-specific `npm.cmd` behavior on Windows.

## Lifecycle guarantees

- Stdout and stderr are each captured with an independent 10 MiB ceiling and
  explicit per-stream truncation metadata.
- Independent bounded 64 KiB tails retain the latest output even after full-log
  truncation.
- One-shot commands have bounded timeouts and support `AbortSignal`.
- Watchers expose status, logs, explicit stop, and an exit promise.
- Shutdown handlers and `dispose()` stop both one-shot and watcher children.
- Windows descendants are terminated by fixed numeric PID with the system
  `taskkill.exe /T /F` process-tree adapter; POSIX children run in process groups and receive
  `SIGTERM`, followed by bounded `SIGKILL` escalation.

Child environments inherit only a small operational allowlist. Extra variables
must be explicitly named by the trusted command definition, and secret-like
environment names are rejected.
