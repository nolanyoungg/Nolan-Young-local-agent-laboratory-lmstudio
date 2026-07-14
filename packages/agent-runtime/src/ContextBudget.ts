import { AgentRuntimeError } from "./errors.js";

export interface BudgetedText {
  readonly text: string;
  readonly estimatedTokens: number;
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly returnedBytes: number;
}

export class ContextBudget {
  public readonly inputTokenLimit: number;

  public constructor(
    public readonly contextTokens: number,
    public readonly reservedOutputTokens = 4_096,
    public readonly safetyRatio = 0.1,
  ) {
    if (contextTokens < 1_024 || reservedOutputTokens < 1) {
      throw new RangeError("Context and output budgets are too small");
    }
    this.inputTokenLimit = Math.floor(contextTokens * (1 - safetyRatio)) - reservedOutputTokens;
    if (this.inputTokenLimit <= 0)
      throw new RangeError("Reserved output consumes the context budget");
  }

  public estimateTokens(value: string): number {
    return Math.ceil(Buffer.byteLength(value, "utf8") / 3.5);
  }

  public fit(value: string, maximumTokens = this.inputTokenLimit): BudgetedText {
    const originalBytes = Buffer.byteLength(value, "utf8");
    const estimatedTokens = this.estimateTokens(value);
    if (estimatedTokens <= maximumTokens) {
      return {
        text: value,
        estimatedTokens,
        truncated: false,
        originalBytes,
        returnedBytes: originalBytes,
      };
    }
    if (maximumTokens < 32) {
      throw new AgentRuntimeError(
        "CONTEXT_BUDGET_EXCEEDED",
        "No room remains for required context",
      );
    }
    const maximumBytes = Math.floor(maximumTokens * 3.5);
    const suffix = "\n[TRUNCATED BY CONTEXT BUDGET]";
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    const bytes = Buffer.from(value, "utf8");
    let prefixEnd = Math.max(0, maximumBytes - suffixBytes);
    while (
      prefixEnd > 0 &&
      bytes[prefixEnd] !== undefined &&
      ((bytes[prefixEnd] ?? 0) & 0xc0) === 0x80
    ) {
      prefixEnd -= 1;
    }
    const truncated = Buffer.concat([bytes.subarray(0, prefixEnd), Buffer.from(suffix)]).toString(
      "utf8",
    );
    return {
      text: truncated,
      estimatedTokens: this.estimateTokens(truncated),
      truncated: true,
      originalBytes,
      returnedBytes: Buffer.byteLength(truncated, "utf8"),
    };
  }
}
