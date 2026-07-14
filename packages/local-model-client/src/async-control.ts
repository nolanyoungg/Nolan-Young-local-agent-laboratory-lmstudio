import { ModelClientError, ModelClientErrorCode } from "./errors.js";

export interface AttemptResult<T> {
  readonly value: T;
  readonly attempts: number;
}

export async function runWithDeadline<T>(
  operationName: string,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parentSignal?.aborted === true) {
    throw new ModelClientError(ModelClientErrorCode.cancelled, `${operationName} was cancelled.`);
  }

  const controller = new AbortController();
  const deadlineState = { timedOut: false };
  let timeoutError: ModelClientError | undefined;
  let rejectDeadline: ((reason: ModelClientError) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    deadlineState.timedOut = true;
    timeoutError = new ModelClientError(
      ModelClientErrorCode.timeout,
      `${operationName} timed out after ${timeoutMs} ms.`,
      {
        retryable: true,
      },
    );
    // Settle the deadline branch before abort listeners can reject the operation as cancelled.
    rejectDeadline?.(timeoutError);
    controller.abort(timeoutError);
  }, timeoutMs);

  const onParentAbort = () => {
    controller.abort();
    rejectDeadline?.(
      new ModelClientError(ModelClientErrorCode.cancelled, `${operationName} was cancelled.`),
    );
  };
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } catch (error) {
    if (deadlineState.timedOut) {
      throw (
        timeoutError ??
        new ModelClientError(
          ModelClientErrorCode.timeout,
          `${operationName} timed out after ${timeoutMs} ms.`,
          { retryable: true, cause: error },
        )
      );
    }
    if (parentSignal?.aborted) {
      throw new ModelClientError(
        ModelClientErrorCode.cancelled,
        `${operationName} was cancelled.`,
        {
          cause: error,
        },
      );
    }
    if (error instanceof ModelClientError) {
      throw error;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

export async function retryModelOperation<T>(
  maximumRetries: number,
  retryDelayMs: number,
  signal: AbortSignal | undefined,
  operation: (attempt: number) => Promise<T>,
): Promise<AttemptResult<T>> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return { value: await operation(attempt), attempts: attempt };
    } catch (error) {
      const retryable = error instanceof ModelClientError && error.retryable;
      if (!retryable || attempt > maximumRetries) {
        throw error;
      }
      await abortableDelay(retryDelayMs, signal);
    }
  }
}

export async function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    throw new ModelClientError(ModelClientErrorCode.cancelled, "Model retry was cancelled.");
  }
  if (delayMs === 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new ModelClientError(ModelClientErrorCode.cancelled, "Model retry was cancelled."));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
