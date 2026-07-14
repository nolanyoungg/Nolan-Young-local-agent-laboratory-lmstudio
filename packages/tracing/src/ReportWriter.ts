import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { TraceError } from "./errors.js";
import { redact } from "./Redaction.js";

export class ReportWriter {
  public async writeText(path: string, content: string): Promise<void> {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new TraceError("REPORT_WRITE_FAILED", `Failed to write report ${path}`, error);
    }
  }

  public async writeJson(path: string, value: unknown, shouldRedact = true): Promise<void> {
    const serializable = shouldRedact ? redact(value) : value;
    await this.writeText(path, `${JSON.stringify(serializable, null, 2)}\n`);
  }
}
