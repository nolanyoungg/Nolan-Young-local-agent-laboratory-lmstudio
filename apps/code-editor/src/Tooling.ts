import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { ToolRegistry, type ToolDefinition } from "@local-agent-lab/agent-runtime";
import {
  ToolFactory,
  type DryRunOverlay,
  type FileMutationResult,
} from "@local-agent-lab/filesystem-tools";
import type { TraceRecorder } from "@local-agent-lab/tracing";
import type { WorkspaceGuard } from "@local-agent-lab/workspace-security";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";

import type { EditPolicy } from "./types.js";

export interface ChangedFileRecord {
  readonly path: string;
  readonly change: "created" | "modified";
  readonly beforeSha256: string | null;
  readonly afterSha256: string;
  readonly bytes: number;
  readonly dryRun: boolean;
}

interface ContentSnapshot {
  readonly path: string;
  readonly before: string | null;
  readonly after: string;
  readonly result: FileMutationResult;
}

export class MutationJournal {
  readonly #before = new Map<string, string | null>();
  readonly #after = new Map<string, string>();
  readonly #results = new Map<string, FileMutationResult>();

  public constructor(
    private readonly guard: WorkspaceGuard,
    private readonly overlay: DryRunOverlay,
    private readonly dryRun: boolean,
    private readonly trace: TraceRecorder,
    private readonly runId: string,
    private readonly maximumFileBytes: number,
  ) {}

  public async observeBefore(requestedPath: string): Promise<string> {
    const guarded = await this.guard.resolveForWrite(requestedPath, {
      mustExist: false,
    });
    if (!this.#before.has(guarded.relativePath)) {
      try {
        this.#before.set(
          guarded.relativePath,
          await readBoundedUtf8(guarded.absolutePath, this.maximumFileBytes),
        );
      } catch (error) {
        if (!isMissingFile(error)) {
          throw error;
        }
        this.#before.set(guarded.relativePath, null);
      }
    }
    return guarded.relativePath;
  }

  public async recordMutation(result: FileMutationResult): Promise<void> {
    const guarded = await this.guard.resolveForWrite(result.path, {
      mustExist: !this.dryRun,
    });
    const finalContent = this.dryRun
      ? this.overlay.get(guarded.relativePath)
      : await readBoundedUtf8(guarded.absolutePath, this.maximumFileBytes);
    if (finalContent === undefined) {
      throw new Error(`Dry-run overlay did not retain ${guarded.relativePath}`);
    }
    this.#after.set(guarded.relativePath, finalContent);
    this.#results.set(guarded.relativePath, result);
    await this.trace.record({
      type: "mutation_journal",
      status: "recorded",
      runId: this.runId,
      metadata: {
        path: guarded.relativePath,
        bytes: result.bytes,
        beforeSha256: result.beforeSha256,
        afterSha256: result.afterSha256,
        dryRun: result.dryRun,
      },
    });
  }

  public snapshots(): readonly ContentSnapshot[] {
    return [...this.#after.entries()]
      .map(([path, after]) => {
        const result = this.#results.get(path);
        if (result === undefined) {
          throw new Error(`Missing mutation result for ${path}`);
        }
        return {
          path,
          before: this.#before.get(path) ?? null,
          after,
          result,
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  public changedFiles(): readonly ChangedFileRecord[] {
    return this.snapshots()
      .filter((snapshot) => snapshot.before !== snapshot.after)
      .map((snapshot) => ({
        path: snapshot.path,
        change: snapshot.before === null ? "created" : "modified",
        beforeSha256: snapshot.before === null ? null : sha256(snapshot.before),
        afterSha256: sha256(snapshot.after),
        bytes: Buffer.byteLength(snapshot.after, "utf8"),
        dryRun: snapshot.result.dryRun,
      }));
  }

  public unifiedDiff(): string {
    return this.snapshots()
      .filter((snapshot) => snapshot.before !== snapshot.after)
      .map((snapshot) => renderFileDiff(snapshot))
      .join("\n");
  }
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

async function readBoundedUtf8(absolutePath: string, maximumBytes: number): Promise<string> {
  const metadata = await lstat(absolutePath);
  if (!metadata.isFile() || metadata.size > maximumBytes) {
    throw new Error("Mutation journal input must be a bounded regular file");
  }
  const buffer = await readFile(absolutePath);
  if (buffer.includes(0)) {
    throw new Error("Mutation journal input must not contain NUL bytes");
  }
  try {
    return strictUtf8.decode(buffer);
  } catch (error) {
    throw new Error("Mutation journal input must be valid UTF-8", { cause: error });
  }
}

export interface CodeEditorTools {
  readonly registry: ToolRegistry;
  readonly journal: MutationJournal;
  readonly overlay: DryRunOverlay;
}

export function createCodeEditorTools(
  options: Readonly<{
    guard: WorkspaceGuard;
    policy: EditPolicy;
    dryRun: boolean;
    trace: TraceRecorder;
    runId: string;
  }>,
): CodeEditorTools {
  const files = ToolFactory.create(options.guard, { dryRun: options.dryRun });
  const journal = new MutationJournal(
    options.guard,
    files.overlay,
    options.dryRun,
    options.trace,
    options.runId,
    options.policy.maximumFileBytes,
  );
  const registry = new ToolRegistry();

  register(registry, {
    name: "list_files",
    description: "List confined workspace files with explicit truncation metadata.",
    mutating: false,
    inputSchema: z
      .object({
        path: z.string().min(1).default("."),
        recursive: z.boolean().default(false),
        maxResults: z
          .number()
          .int()
          .positive()
          .max(options.policy.maximumFiles)
          .default(Math.min(500, options.policy.maximumFiles)),
      })
      .strict(),
    execute: async (input) => files.listFiles.execute(input),
  });
  register(registry, {
    name: "read_file",
    description: "Read bounded UTF-8 text and its SHA-256 precondition hash.",
    mutating: false,
    inputSchema: z
      .object({
        path: z.string().min(1),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
        maxOutputBytes: z
          .number()
          .int()
          .positive()
          .max(options.policy.maximumOutputBytes)
          .default(options.policy.maximumOutputBytes),
      })
      .strict()
      .superRefine((value, context) => {
        if (
          value.startLine !== undefined &&
          value.endLine !== undefined &&
          value.endLine < value.startLine
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "endLine must not precede startLine",
            path: ["endLine"],
          });
        }
      }),
    execute: async (input) => files.readFile.execute(input),
  });
  register(registry, {
    name: "read_file_metadata",
    description: "Read confined file metadata and its content hash without mutation.",
    mutating: false,
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    execute: async (input) => files.readFileMetadata.execute(input),
  });
  register(registry, {
    name: "search_text",
    description: "Search bounded UTF-8 workspace text, including dry-run overlay content.",
    mutating: false,
    inputSchema: z
      .object({
        path: z.string().min(1).default("."),
        query: z.string().min(1).max(1_000),
        caseSensitive: z.boolean().default(false),
        maxResults: z
          .number()
          .int()
          .positive()
          .max(options.policy.maximumSearchMatches)
          .default(Math.min(100, options.policy.maximumSearchMatches)),
      })
      .strict(),
    execute: async (input) => files.searchText.execute(input),
  });

  const boundedContent = z
    .string()
    .refine(
      (content) => Buffer.byteLength(content, "utf8") <= options.policy.maximumFileBytes,
      `content exceeds ${options.policy.maximumFileBytes} UTF-8 bytes`,
    );
  register(registry, {
    name: "create_file",
    description: "Atomically create a confirmed-absent confined UTF-8 file.",
    mutating: true,
    inputSchema: z.object({ path: z.string().min(1), content: boundedContent }).strict(),
    execute: async (input) => {
      const relativePath = await journal.observeBefore(input.path);
      await options.trace.record({
        type: "mutation",
        status: "authorized",
        runId: options.runId,
        metadata: { tool: "create_file", path: relativePath },
      });
      const result = await files.createFile.execute(input);
      await journal.recordMutation(result);
      return result;
    },
  });
  register(registry, {
    name: "write_file",
    description: "Atomically replace a confined UTF-8 file using its observed SHA-256.",
    mutating: true,
    inputSchema: z
      .object({
        path: z.string().min(1),
        content: boundedContent,
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    execute: async (input) => {
      const relativePath = await journal.observeBefore(input.path);
      await options.trace.record({
        type: "mutation",
        status: "authorized",
        runId: options.runId,
        metadata: {
          tool: "write_file",
          path: relativePath,
          beforeSha256: input.expectedSha256,
        },
      });
      const result = await files.writeFile.execute(input);
      await journal.recordMutation(result);
      return result;
    },
  });
  register(registry, {
    name: "apply_patch",
    description: "Apply one hash-checked unified diff to one confined existing file.",
    mutating: true,
    inputSchema: z
      .object({
        path: z.string().min(1),
        patch: z.string().min(1).max(1_048_576),
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    execute: async (input) => {
      const relativePath = await journal.observeBefore(input.path);
      await options.trace.record({
        type: "mutation",
        status: "authorized",
        runId: options.runId,
        metadata: {
          tool: "apply_patch",
          path: relativePath,
          beforeSha256: input.expectedSha256,
        },
      });
      const result = await files.applyPatch.execute(input);
      await journal.recordMutation(result);
      return result;
    },
  });

  return { registry, journal, overlay: files.overlay };
}

function register<TInput>(registry: ToolRegistry, definition: ToolDefinition<TInput>): void {
  registry.register(definition);
}

function renderFileDiff(snapshot: ContentSnapshot): string {
  const oldName = `a/${snapshot.path}`;
  const newName = `b/${snapshot.path}`;
  let patch = createTwoFilesPatch(oldName, newName, snapshot.before ?? "", snapshot.after, "", "", {
    context: 3,
  });
  if (snapshot.before === null) {
    patch = patch.replace(/^--- .*$/mu, "--- /dev/null");
  }
  return `diff --git ${oldName} ${newName}\n${patch.trimEnd()}\n`;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
