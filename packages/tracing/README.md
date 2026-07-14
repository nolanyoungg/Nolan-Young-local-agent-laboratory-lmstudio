# @local-agent-lab/tracing

Local-only run directories, serialized JSONL traces, atomic report writes, and recursive secret redaction.

The package records metadata rather than prompts, model output, file contents, authorization headers, or complete environments. A workflow must create its run directory before it executes a mutating tool.
