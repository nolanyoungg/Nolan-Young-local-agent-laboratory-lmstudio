# `@local-agent-lab/workspace-security`

Security boundary for every filesystem operation performed by the laboratory. A
`WorkspaceGuard` canonicalizes one real directory for a run and accepts only portable relative
paths beneath it. Absolute paths, UNC/device paths, traversal, malformed Windows names, null
bytes, excessive path lengths, and symlink or junction components are rejected.

```ts
import { PathPolicy, WorkspaceGuard } from "@local-agent-lab/workspace-security";

const guard = await WorkspaceGuard.create(targetWorkspace, {
  pathPolicy: new PathPolicy({
    readGlobs: ["src/**", "package.json"],
    writeGlobs: ["src/**"],
    deleteGlobs: [],
  }),
});

const file = await guard.resolveForRead("src/index.ts");
```

Default protected paths include Git metadata, environment files, dependency/package caches,
credential and key material, certificates, `node_modules`, and laboratory reports. These denies
always override caller-supplied allow globs. Deletion has a separate allowlist and is disabled by
default; this package does not implement recursive deletion.

## Locks

`WorkspaceLock.acquire` writes a nonce-owned lock outside the target workspace under an explicit
trusted lock root. Publication is atomic and competing acquisition fails closed. A lock can be
recovered only once when all three conditions hold: it is at least five minutes old, it belongs
to the same hostname, and its recorded PID is absent. Release verifies the nonce and refuses to
remove a replacement owner's lock.

```ts
const lock = await WorkspaceLock.acquire({
  workspaceRoot: targetWorkspace,
  trustedLockRoot: applicationOwnedLockDirectory,
});

try {
  // Run the workflow.
} finally {
  await lock.release();
}
```

The trusted lock directory must be application-owned and outside the model-accessible target
workspace. Guards must be applied immediately before each filesystem operation; they do not make
multi-step filesystem sequences immune to operating-system race conditions.
