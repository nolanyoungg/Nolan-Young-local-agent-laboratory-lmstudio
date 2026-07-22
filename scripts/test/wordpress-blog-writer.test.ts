import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  defaultOutputDirectory,
  defaultTrackerPath,
  requiredTrackerHeaders,
  runWordPressBlogWriter,
  type BlogGenerator,
} from "../wordpress-blog-writer.js";

const generator: BlogGenerator = {
  generate: async ({ topic, wordCount }) =>
    `# ${topic}\n\n${Array.from({ length: wordCount }, () => "useful").join(" ")}`,
};

const createTracker = async (rows: readonly (readonly string[])[]): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lmstudio-blog-writer-"));
  const tracker = path.join(root, "content.xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Blog tracker");
  sheet.addRow(requiredTrackerHeaders);
  rows.forEach((row) => sheet.addRow(row));
  await workbook.xlsx.writeFile(tracker);
  return tracker;
};

describe("LM Studio WordPress blog writer", () => {
  it("uses centralized default paths", () => {
    expect(defaultTrackerPath).toMatch(/manual-files[\\/]wordpress-blog-content-tracker\.xlsx$/u);
    expect(defaultOutputDirectory).toMatch(/dist[\\/]wordpress-blog-writer$/u);
  });

  it("writes the first pending blog without changing the tracker in draft mode", async () => {
    const tracker = await createTracker([
      ["blog-1", "Build a WordPress website", "pending", "", ""],
      ["blog-2", "Build a WordPress plugin", "pending", "", ""],
    ]);
    const result = await runWordPressBlogWriter({
      tracker,
      outputDirectory: path.join(path.dirname(tracker), "drafts"),
      wordCount: 200,
      generator,
    });
    expect(result).toMatchObject({ blogId: "blog-1", status: "draft" });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(tracker);
    expect(workbook.worksheets[0]!.getRow(2).getCell(3).value).toBe("pending");
  });

  it("completes the pending row and writes its created date only with approval", async () => {
    const tracker = await createTracker([
      ["blog-1", "Build a WordPress website", "pending", "", ""],
    ]);
    await expect(
      runWordPressBlogWriter({
        tracker,
        outputDirectory: path.join(path.dirname(tracker), "drafts"),
        approve: true,
        wordCount: 200,
        generator,
        now: new Date("2026-07-22T23:20:46.000Z"),
      }),
    ).resolves.toMatchObject({ blogId: "blog-1", status: "complete" });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(tracker);
    const row = workbook.worksheets[0]!.getRow(2);
    expect(row.getCell(3).value).toBe("complete");
    expect(row.getCell(4).value).toBeInstanceOf(Date);
    expect(row.getCell(5).value).toBe("");
  });

  it("rejects invalid status values and placeholder drafts", async () => {
    const invalidTracker = await createTracker([
      ["blog-1", "Build a WordPress website", "queued", "", ""],
    ]);
    await expect(runWordPressBlogWriter({ tracker: invalidTracker, generator })).rejects.toThrow(
      "invalid blog_status",
    );
    const tracker = await createTracker([
      ["blog-1", "Build a WordPress website", "pending", "", ""],
    ]);
    await expect(
      runWordPressBlogWriter({
        tracker,
        outputDirectory: path.join(path.dirname(tracker), "drafts"),
        wordCount: 100,
        generator: { generate: async () => "TODO " + "content ".repeat(120) },
      }),
    ).rejects.toThrow("placeholder text");
  });
});
