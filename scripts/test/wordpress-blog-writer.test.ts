import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  requiredTrackerHeaders,
  runWordPressBlogWriter,
  type BlogGenerator,
} from "../wordpress-blog-writer.js";

const generator: BlogGenerator = {
  generate: async ({ topic, wordCount }) =>
    `# ${topic}\n\n${Array.from({ length: wordCount }, () => "useful").join(" ")}`,
};

const createTracker = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lmstudio-blog-writer-"));
  const tracker = path.join(root, "content.xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Content");
  sheet.addRow(requiredTrackerHeaders);
  sheet.addRow(["blog-1", "Build a WordPress website", "", "pending", false, "", "", "", ""]);
  sheet.addRow(["blog-2", "Build a WordPress plugin", "", "pending", false, "", "", "", ""]);
  await workbook.xlsx.writeFile(tracker);
  return tracker;
};

describe("LM Studio WordPress blog writer", () => {
  it("writes the first pending blog and advances to the next row", async () => {
    const tracker = await createTracker();
    const drafts = path.join(path.dirname(tracker), "drafts");
    await expect(
      runWordPressBlogWriter({
        tracker,
        outputDirectory: drafts,
        recipient: "nolanyoung7@yahoo.com",
        approve: true,
        wordCount: 200,
        generator,
      }),
    ).resolves.toMatchObject({ blogId: "blog-1", delivery: "previewed" });
    await expect(
      runWordPressBlogWriter({
        tracker,
        outputDirectory: drafts,
        recipient: "nolanyoung7@yahoo.com",
        approve: true,
        wordCount: 200,
        generator,
      }),
    ).resolves.toMatchObject({ blogId: "blog-2" });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(tracker);
    const sheet = workbook.getWorksheet("Content")!;
    expect(sheet.getRow(2).getCell(4).value).toBe("completed");
    expect(sheet.getRow(3).getCell(4).value).toBe("completed");
  });

  it("does not complete a row when the article contains placeholder text", async () => {
    const tracker = await createTracker();
    await expect(
      runWordPressBlogWriter({
        tracker,
        outputDirectory: path.join(path.dirname(tracker), "drafts"),
        recipient: "nolanyoung7@yahoo.com",
        approve: true,
        wordCount: 100,
        generator: { generate: async () => "TODO " + "content ".repeat(120) },
      }),
    ).rejects.toThrow("placeholder text");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(tracker);
    expect(workbook.getWorksheet("Content")!.getRow(2).getCell(4).value).toBe("pending");
  });

  it("requires explicit approval for tracker updates and exact confirmation for delivery", async () => {
    const tracker = await createTracker();
    await expect(
      runWordPressBlogWriter({
        tracker,
        outputDirectory: path.join(path.dirname(tracker), "drafts"),
        recipient: "nolanyoung7@yahoo.com",
        send: true,
        confirmBlogId: "blog-1",
        generator,
      }),
    ).rejects.toThrow("--approve");
    await expect(
      runWordPressBlogWriter({
        tracker,
        outputDirectory: path.join(path.dirname(tracker), "drafts"),
        recipient: "nolanyoung7@yahoo.com",
        approve: true,
        send: true,
        confirmBlogId: "blog-2",
        generator,
      }),
    ).rejects.toThrow("--confirm blog-1");
  });
});
