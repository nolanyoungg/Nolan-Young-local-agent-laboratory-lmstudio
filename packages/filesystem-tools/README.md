# `@local-agent-lab/filesystem-tools`

Deterministic, policy-gated text-file tools for the local agent runtime. Every
path is resolved by an injected `WorkspaceGuardLike`; the package never accepts
an unrestricted filesystem root or exposes deletion.

## Safety limits

- Files and proposed file contents: 1 MiB maximum.
- Tool output: 128 KiB maximum.
- UTF-8 text only; null bytes, invalid UTF-8, and binary-like control content
  are rejected.
- Writes use a same-directory temporary file and atomic rename. Creates use a
  fully written temporary file and an exclusive hard-link operation.
- Unified patches target exactly one existing file and require its current
  SHA-256 hash.
- Listings and searches are deterministically sorted and bounded.

## Dry runs

`ToolFactory.create(guard, { dryRun: true })` shares an in-memory overlay across
all returned tools. Creates, writes, and patches update only that overlay;
subsequent reads, metadata calls, listings, and searches observe the proposed
content while the workspace remains unchanged.

The concrete `WorkspaceGuard` can be injected structurally when it implements
`resolveForRead()` and `resolveForWrite()`. All traversal, symlink, forbidden
path, and read/write policy decisions remain the security package's authority.
