import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publishFinalArtifact } from "@local-agent-lab/agent-runtime";

describe("final artifact publisher", () => {
  it("copies only the finished Markdown report into the producer dist directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "final-artifact-"));
    const reportPath = path.join(root, "reports", "agent-runs", "run-1", "report.md");
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, "# Finished report\n", "utf8");
    const destination = await publishFinalArtifact({
      root,
      producerId: "wordpress-theme-verification-agent",
      reportPath,
    });
    expect(destination).toMatch(
      /dist[\\/]wordpress-theme-verification-agent[\\/]\d{8}T\d{6}\d{3}Z-report\.md$/u,
    );
    await expect(readFile(destination, "utf8")).resolves.toBe("# Finished report\n");
  });
});
