# Agent Definition Audit

Audit a local agent-library definition against its loader and safety boundaries. Base each finding on directly inspected content. A missing or malformed field is a finding only when the loader or documented contract requires it.

## Checklist

1. Confirm every `agents/*/AGENT.md` contains a non-empty `id`, `defaultSkills`, `allowedTools`, and positive `maxSteps` field.
2. Confirm each default skill resolves to `skills/<id>/SKILL.md` and that its instructions are readable and relevant to the agent role.
3. Confirm `allowedTools` uses only tools the library permits and that role instructions do not imply write, command, network, credential, or other unavailable access.
4. Compare the manifest format with the agent loader. Flag field values that the loader would reject, misparse, or silently interpret differently than intended.
5. Evaluate whether the instructions define a clear scope, require direct evidence, prohibit unsupported claims, and require limitations when evidence is incomplete.
6. Flag conflicting role and skill instructions, contradictory safety requirements, vague success conditions, or step limits disproportionate to the agent's bounded task.
7. Inspect runtime/reporting code only when needed to substantiate a compatibility or evidence-handling conclusion. Do not infer runtime behavior from a manifest alone.

## Reporting guidance

- Use `critical` or `high` only for a demonstrated bypass of the read-only boundary, evidence validation, or a broad failure affecting every agent.
- Use `medium` for a definition that will fail to load, references a missing skill, or materially undermines reliable reviews.
- Use `low` for clarity, consistency, or maintainability concerns that do not prevent safe operation.
- When no issue is supported, return an empty findings list and explain the inspected scope.
