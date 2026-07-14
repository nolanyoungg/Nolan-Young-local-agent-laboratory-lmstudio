import { performance } from "node:perf_hooks";
import type { JsonlTraceWriter } from "./JsonlTraceWriter.js";
import { sanitizedError } from "./Redaction.js";

export interface TraceEventInput {
  readonly type: string;
  readonly status: string;
  readonly runId: string;
  readonly agentId?: string;
  readonly step?: number;
  readonly toolCallId?: string;
  readonly durationMs?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export class TraceRecorder {
  private sequence = 0;

  public constructor(
    private readonly writer: JsonlTraceWriter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public record(event: TraceEventInput): Promise<void> {
    this.sequence += 1;
    return this.writer.append({
      ...event,
      ...(event.metadata === undefined ? {} : { metadata: sanitizeTraceMetadata(event.metadata) }),
      sequence: this.sequence,
      timestamp: this.now().toISOString(),
    });
  }

  public recordError(event: Omit<TraceEventInput, "status">, error: unknown): Promise<void> {
    return this.record({
      ...event,
      status: "error",
      metadata: { ...event.metadata, error: sanitizedError(error) },
    });
  }

  public async measure<T>(
    event: Omit<TraceEventInput, "status" | "durationMs">,
    operation: () => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    await this.record({ ...event, status: "started" });
    try {
      const result = await operation();
      await this.record({ ...event, status: "completed", durationMs: performance.now() - started });
      return result;
    } catch (error) {
      await this.recordError({ ...event, durationMs: performance.now() - started }, error);
      throw error;
    }
  }

  public close(): Promise<void> {
    return this.writer.close();
  }
}

const FORBIDDEN_METADATA_KEY =
  /^(?:authorization|content|cookie|environment|env|input|messages?|output|password|prompt|requestBody|responseBody|secret|stderr|stdout|task|token)$/iu;

function sanitizeTraceMetadata(value: unknown, key = "metadata"): unknown {
  if (FORBIDDEN_METADATA_KEY.test(key)) {
    return "[OMITTED FROM TRACE]";
  }
  if (typeof value === "string") {
    if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/u.test(value)) {
      return "[ABSOLUTE PATH OMITTED]";
    }
    return value.slice(0, 1_024);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 128).map((item) => sanitizeTraceMetadata(item));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 128)
        .map(([nestedKey, nestedValue]) => [
          nestedKey,
          sanitizeTraceMetadata(nestedValue, nestedKey),
        ]),
    );
  }
  return String(value).slice(0, 256);
}
