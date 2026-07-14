import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redact } from "./Redaction.js";
import { TraceError } from "./errors.js";

export class JsonlTraceWriter {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  public constructor(private readonly path: string) {}

  public append(event: unknown): Promise<void> {
    if (this.closed)
      return Promise.reject(new TraceError("TRACE_CLOSED", "Trace writer is closed"));
    const line = `${JSON.stringify(redact(event))}\n`;
    this.queue = this.queue.then(async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, line, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        throw new TraceError("TRACE_APPEND_FAILED", `Failed to append trace ${this.path}`, error);
      }
    });
    return this.queue;
  }

  public async flush(): Promise<void> {
    await this.queue;
  }

  public async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }
}
