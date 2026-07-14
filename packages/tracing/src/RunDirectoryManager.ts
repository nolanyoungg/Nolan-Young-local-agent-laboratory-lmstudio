import { mkdir, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { ReportWriter } from "./ReportWriter.js";
import { TraceError } from "./errors.js";

export interface RunDirectory {
  readonly runId: string;
  readonly path: string;
  readonly tracePath: string;
  readonly metadataPath: string;
  readonly diagnosticsPath: string;
  readonly finalReportPath: string;
  readonly finalResultPath: string;
  readonly artifactsPath: string;
}

export interface CreateRunOptions {
  readonly application: string;
  readonly workspaceRoot: string;
  readonly modelProvider: string;
  readonly requestedModel: string;
  readonly mode: string;
}

function safeTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, "");
}

function safeApplication(value: string): string {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(value)) {
    throw new TraceError("INVALID_APPLICATION_NAME", `Unsafe application name: ${value}`);
  }
  return value;
}

export class RunDirectoryManager {
  public constructor(
    private readonly reportsRoot: string,
    private readonly reportWriter = new ReportWriter(),
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  public async create(options: CreateRunOptions): Promise<RunDirectory> {
    const application = safeApplication(options.application);
    const root = resolve(this.reportsRoot);
    await mkdir(root, { recursive: true });
    const canonicalReportsRoot = await realpath(root);
    const runId = this.createId();
    const path = resolve(
      canonicalReportsRoot,
      `${safeTimestamp(this.now())}-${application}-${runId}`,
    );
    if (
      !path.startsWith(`${canonicalReportsRoot}\\`) &&
      !path.startsWith(`${canonicalReportsRoot}/`)
    ) {
      throw new TraceError("UNSAFE_RUN_PATH", "Generated run path escaped the reports root");
    }
    await mkdir(resolve(path, "artifacts"), { recursive: true });

    const directory: RunDirectory = {
      runId,
      path,
      tracePath: resolve(path, "trace.jsonl"),
      metadataPath: resolve(path, "run-metadata.json"),
      diagnosticsPath: resolve(path, "model-diagnostics.json"),
      finalReportPath: resolve(path, "final-report.md"),
      finalResultPath: resolve(path, "final-result.json"),
      artifactsPath: resolve(path, "artifacts"),
    };

    await this.reportWriter.writeJson(directory.metadataPath, {
      runId,
      application,
      startedAt: this.now().toISOString(),
      workspace: {
        name: basename(resolve(options.workspaceRoot)),
        canonicalPathSha256: createHash("sha256")
          .update(resolve(options.workspaceRoot))
          .digest("hex"),
      },
      modelProvider: options.modelProvider,
      requestedModel: options.requestedModel,
      mode: options.mode,
      processId: process.pid,
      nodeVersion: process.version,
    });
    return directory;
  }
}
