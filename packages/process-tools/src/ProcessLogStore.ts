export const MAX_PROCESS_LOG_BYTES = 10 * 1_024 * 1_024;
export const MAX_PROCESS_TAIL_BYTES = 64 * 1_024;

export type ProcessLogStream = "stderr" | "stdout";

export interface ProcessLogSnapshot {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly truncated: boolean;
}

export class ProcessLogStore {
  readonly #maximumBytes: number;
  readonly #tailBytes: number;
  readonly #stored: Record<ProcessLogStream, Buffer[]> = {
    stdout: [],
    stderr: [],
  };
  readonly #tails: Record<ProcessLogStream, Buffer> = {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  };
  readonly #seen: Record<ProcessLogStream, number> = { stdout: 0, stderr: 0 };
  readonly #storedBytes: Record<ProcessLogStream, number> = {
    stdout: 0,
    stderr: 0,
  };
  readonly #truncatedStreams: Record<ProcessLogStream, boolean> = {
    stdout: false,
    stderr: false,
  };

  public constructor(maximumBytes = MAX_PROCESS_LOG_BYTES, tailBytes = MAX_PROCESS_TAIL_BYTES) {
    this.#maximumBytes = maximumBytes;
    this.#tailBytes = tailBytes;
  }

  public append(stream: ProcessLogStream, chunk: string | Uint8Array): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    this.#seen[stream] += buffer.byteLength;

    const available = Math.max(0, this.#maximumBytes - this.#storedBytes[stream]);
    if (available > 0) {
      const storedChunk = buffer.subarray(0, available);
      this.#stored[stream].push(storedChunk);
      this.#storedBytes[stream] += storedChunk.byteLength;
    }
    if (buffer.byteLength > available) {
      this.#truncatedStreams[stream] = true;
    }

    const incomingTail = buffer.subarray(Math.max(0, buffer.byteLength - this.#tailBytes));
    const combinedTail = Buffer.concat([this.#tails[stream], incomingTail]);
    this.#tails[stream] = combinedTail.subarray(
      Math.max(0, combinedTail.byteLength - this.#tailBytes),
    );
  }

  public snapshot(): ProcessLogSnapshot {
    const stdout = this.#boundedOutput("stdout");
    const stderr = this.#boundedOutput("stderr");
    return Object.freeze({
      stdout,
      stderr,
      stdoutTail: this.#boundedTail("stdout"),
      stderrTail: this.#boundedTail("stderr"),
      stdoutBytes: this.#seen.stdout,
      stderrBytes: this.#seen.stderr,
      stdoutTruncated: this.#truncatedStreams.stdout,
      stderrTruncated: this.#truncatedStreams.stderr,
      truncated: this.#truncatedStreams.stdout || this.#truncatedStreams.stderr,
    });
  }

  #boundedOutput(stream: ProcessLogStream): string {
    const value = Buffer.concat(this.#stored[stream]);
    if (!this.#truncatedStreams[stream]) {
      return value.toString("utf8");
    }
    return withTruncationMarker(value, this.#maximumBytes);
  }

  #boundedTail(stream: ProcessLogStream): string {
    const value = this.#tails[stream];
    if (this.#seen[stream] <= this.#tailBytes) {
      return value.toString("utf8");
    }
    return withTruncationMarker(value, this.#tailBytes, true);
  }
}

const TRUNCATION_MARKER = "\n[TRUNCATED: bounded process log]\n";

function withTruncationMarker(value: Buffer, maximumBytes: number, markerFirst = false): string {
  const marker = Buffer.from(TRUNCATION_MARKER, "utf8");
  if (maximumBytes <= marker.byteLength) {
    return marker.subarray(0, maximumBytes).toString("utf8");
  }
  const retainedBytes = Math.max(0, maximumBytes - marker.byteLength);
  const retained = markerFirst
    ? value.subarray(Math.max(0, value.byteLength - retainedBytes))
    : value.subarray(0, retainedBytes);
  return Buffer.concat(markerFirst ? [marker, retained] : [retained, marker]).toString("utf8");
}
