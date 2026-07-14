import type {
  ProcessLogSnapshot,
  ProcessResult,
  WatcherHandle,
} from "@local-agent-lab/process-tools";

import { BuildAssistantError } from "./errors.js";
import type { ProcessObservation, WatcherPolicy } from "./types.js";

export const MAX_MODEL_LOG_BYTES = 64 * 1_024;

export interface LogOffsets {
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

export interface WatcherObservationResult {
  readonly observation: ProcessObservation;
  readonly offsets: LogOffsets;
}

function utf8Tail(value: string, maximumBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maximumBytes) return value;
  return buffer.subarray(buffer.byteLength - maximumBytes).toString("utf8");
}

function sanitizeLog(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/\blm_[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replaceAll("\0", "�");
}

function unseenTail(
  tail: string,
  totalBytes: number,
  seenBytes: number,
  maximumBytes: number,
): string {
  const unseenBytes = Math.max(0, totalBytes - seenBytes);
  if (unseenBytes === 0) return "";
  const available = Math.min(unseenBytes, maximumBytes);
  return sanitizeLog(utf8Tail(tail, available));
}

export function boundedLogDelta(
  snapshot: ProcessLogSnapshot,
  offsets: LogOffsets,
): { readonly stdout: string; readonly stderr: string; readonly offsets: LogOffsets } {
  const perStream = MAX_MODEL_LOG_BYTES / 2;
  return {
    stdout: unseenTail(snapshot.stdoutTail, snapshot.stdoutBytes, offsets.stdoutBytes, perStream),
    stderr: unseenTail(snapshot.stderrTail, snapshot.stderrBytes, offsets.stderrBytes, perStream),
    offsets: {
      stdoutBytes: snapshot.stdoutBytes,
      stderrBytes: snapshot.stderrBytes,
    },
  };
}

export function observeOneShot(result: ProcessResult): ProcessObservation {
  const delta = boundedLogDelta(result, { stdoutBytes: 0, stderrBytes: 0 });
  return {
    commandId: result.commandId,
    kind: "one-shot",
    status: result.exitCode === 0 && !result.timedOut ? "succeeded" : "failed",
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdoutDelta: delta.stdout,
    stderrDelta: delta.stderr,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    truncated: result.truncated,
  };
}

function findLiteral(haystack: string, patterns: readonly string[]): string | undefined {
  const normalized = haystack.toLowerCase();
  return patterns.find((pattern) => normalized.includes(pattern.toLowerCase()));
}

export async function observeWatcher(
  handle: WatcherHandle,
  policy: WatcherPolicy,
  options: Readonly<{
    timeoutMs: number;
    offsets: LogOffsets;
    signal?: AbortSignal;
    pollMs?: number;
  }>,
): Promise<WatcherObservationResult> {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const pollMs = options.pollMs ?? 50;
  let offsets = options.offsets;
  let stdout = "";
  let stderr = "";
  let lastBytes = offsets.stdoutBytes + offsets.stderrBytes;
  let lastChangeAt = Date.now();

  while (Date.now() <= deadline) {
    if (options.signal?.aborted === true) {
      throw new BuildAssistantError(
        "INTERRUPTED",
        "Watcher observation was interrupted.",
        "interrupted",
      );
    }
    const snapshot = handle.getLogs();
    const delta = boundedLogDelta(snapshot, offsets);
    offsets = delta.offsets;
    stdout = utf8Tail(`${stdout}${delta.stdout}`, MAX_MODEL_LOG_BYTES / 2);
    stderr = utf8Tail(`${stderr}${delta.stderr}`, MAX_MODEL_LOG_BYTES / 2);
    const totalBytes = snapshot.stdoutBytes + snapshot.stderrBytes;
    if (totalBytes !== lastBytes) {
      lastBytes = totalBytes;
      lastChangeAt = Date.now();
    }
    const combined = `${stdout}\n${stderr}`;
    const failure = findLiteral(combined, policy.failurePatterns);
    const success = findLiteral(combined, policy.successPatterns);
    const ready = findLiteral(combined, policy.readyPatterns);
    const settled = Date.now() - lastChangeAt >= policy.settleMs;
    const status = handle.getStatus();
    const exited = status?.status === "exited" || status?.status === "failed";

    if (settled && failure !== undefined) {
      return {
        observation: {
          commandId: handle.commandId,
          kind: "watcher",
          status: "failed",
          exitCode: status?.exitCode ?? null,
          signal: status?.signal ?? null,
          timedOut: false,
          durationMs: Date.now() - startedAt,
          stdoutDelta: stdout,
          stderrDelta: stderr,
          stdoutBytes: snapshot.stdoutBytes,
          stderrBytes: snapshot.stderrBytes,
          truncated: snapshot.truncated,
          matchedPattern: failure,
        },
        offsets,
      };
    }
    if (
      settled &&
      (success !== undefined ||
        (policy.successPatterns.length === 0 && ready !== undefined) ||
        (exited && status?.exitCode === 0))
    ) {
      const matchedPattern = success ?? ready;
      return {
        observation: {
          commandId: handle.commandId,
          kind: "watcher",
          status: "succeeded",
          exitCode: status?.exitCode ?? null,
          signal: status?.signal ?? null,
          timedOut: false,
          durationMs: Date.now() - startedAt,
          stdoutDelta: stdout,
          stderrDelta: stderr,
          stdoutBytes: snapshot.stdoutBytes,
          stderrBytes: snapshot.stderrBytes,
          truncated: snapshot.truncated,
          ...(matchedPattern === undefined ? {} : { matchedPattern }),
        },
        offsets,
      };
    }
    if (exited) {
      return {
        observation: {
          commandId: handle.commandId,
          kind: "watcher",
          status: "failed",
          exitCode: status?.exitCode ?? null,
          signal: status?.signal ?? null,
          timedOut: false,
          durationMs: Date.now() - startedAt,
          stdoutDelta: stdout,
          stderrDelta: stderr,
          stdoutBytes: snapshot.stdoutBytes,
          stderrBytes: snapshot.stderrBytes,
          truncated: snapshot.truncated,
        },
        offsets,
      };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }

  const snapshot = handle.getLogs();
  const delta = boundedLogDelta(snapshot, offsets);
  return {
    observation: {
      commandId: handle.commandId,
      kind: "watcher",
      status: "failed",
      exitCode: handle.getStatus()?.exitCode ?? null,
      signal: handle.getStatus()?.signal ?? null,
      timedOut: true,
      durationMs: Date.now() - startedAt,
      stdoutDelta: utf8Tail(`${stdout}${delta.stdout}`, MAX_MODEL_LOG_BYTES / 2),
      stderrDelta: utf8Tail(`${stderr}${delta.stderr}`, MAX_MODEL_LOG_BYTES / 2),
      stdoutBytes: snapshot.stdoutBytes,
      stderrBytes: snapshot.stderrBytes,
      truncated: snapshot.truncated,
    },
    offsets: delta.offsets,
  };
}

export function logMetadata(observation: ProcessObservation): Readonly<Record<string, unknown>> {
  return {
    commandId: observation.commandId,
    kind: observation.kind,
    status: observation.status,
    exitCode: observation.exitCode,
    signal: observation.signal,
    timedOut: observation.timedOut,
    durationMs: observation.durationMs,
    stdoutBytes: observation.stdoutBytes,
    stderrBytes: observation.stderrBytes,
    truncated: observation.truncated,
    matchedPattern: observation.matchedPattern,
  };
}
