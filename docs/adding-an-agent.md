# Adding an agent role

Define a narrow role identifier, a strict completion schema, a one-action-per-turn system prompt, and an explicit tool allowlist. Register only tools whose schemas are discriminated by exact names. A role must not inherit another role's permissions or access policy files that govern it.

Add tests for unknown tools, invalid input, invalid completion envelopes, repeated call IDs, changed-input call-ID reuse, and mutation fingerprint replay.
