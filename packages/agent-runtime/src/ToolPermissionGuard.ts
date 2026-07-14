import { AgentRuntimeError } from "./errors.js";

export class ToolPermissionGuard {
  private readonly allowed: ReadonlySet<string>;

  public constructor(allowedTools: readonly string[]) {
    this.allowed = new Set(allowedTools);
  }

  public assertAllowed(tool: string): void {
    if (!this.allowed.has(tool)) {
      throw new AgentRuntimeError("DISALLOWED_TOOL", `Agent is not permitted to call ${tool}`, {
        tool,
      });
    }
  }
}
