# `@local-agent-lab/shared-types`

Runtime-validated contracts shared by the local agent laboratory. Every externally supplied
configuration value, model response, tool request, trace event, and workflow result should be
parsed with its exported Zod schema before it is trusted.

The package deliberately permits only the `lmstudio` runtime provider and the deterministic
`mock` test provider. LM Studio endpoints are restricted to the Windows loopback interface and
embedded URL credentials are rejected.

```ts
import { LMStudioConnectionConfigSchema, ToolCallSchema } from "@local-agent-lab/shared-types";

const lmStudio = LMStudioConnectionConfigSchema.parse(configuration);
const toolCall = ToolCallSchema.parse(modelOutput);
```

`ToolCallSchema`, `ToolResultSchema`, `AgentTurnSchema`, and `TraceEventSchema` are discriminated
unions. Consumers should switch exhaustively on their discriminator rather than accepting an
unvalidated JSON action.
