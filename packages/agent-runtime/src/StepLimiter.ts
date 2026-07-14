import { AgentRuntimeError } from "./errors.js";

export class StepLimiter {
  private used = 0;

  public constructor(public readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_000) {
      throw new RangeError("maximum steps must be an integer from 1 to 1000");
    }
  }

  public next(): number {
    if (this.used >= this.maximum) {
      throw new AgentRuntimeError("STEP_LIMIT_EXCEEDED", `Agent exceeded ${this.maximum} steps`, {
        maximum: this.maximum,
      });
    }
    this.used += 1;
    return this.used;
  }

  public get count(): number {
    return this.used;
  }
}
