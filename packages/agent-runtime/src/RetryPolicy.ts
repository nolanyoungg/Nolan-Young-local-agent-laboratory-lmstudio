export interface RetryEvent {
  readonly attempt: number;
  readonly delayMs: number;
  readonly error: unknown;
}

export class RetryPolicy {
  public constructor(
    public readonly maximumRetries: number,
    public readonly delayMs: number,
  ) {
    if (!Number.isSafeInteger(maximumRetries) || maximumRetries < 0 || maximumRetries > 10) {
      throw new RangeError("maximumRetries must be an integer from 0 to 10");
    }
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
      throw new RangeError("delayMs must be an integer from 0 to 60000");
    }
  }

  public async execute<T>(
    operation: (attempt: number) => Promise<T>,
    shouldRetry: (error: unknown) => boolean,
    onRetry?: (event: RetryEvent) => Promise<void> | void,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await operation(attempt);
      } catch (error) {
        if (attempt >= this.maximumRetries || !shouldRetry(error)) throw error;
        attempt += 1;
        const delayMs = this.delayMs * attempt;
        await onRetry?.({ attempt, delayMs, error });
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}
