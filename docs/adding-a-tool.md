# Adding a tool

Every model-facing tool needs a strict Zod input schema, bounded typed output, permission registration, trace-safe metadata, and tests for rejection paths. Paths remain normalized relative paths; commands remain symbolic IDs. A mutation must revalidate containment immediately before writing, require an optimistic precondition, and supply a stable mutation fingerprint. No deletion tool is permitted.
