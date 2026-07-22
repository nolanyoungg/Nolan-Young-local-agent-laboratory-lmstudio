import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { z } from "zod";
import { createLMStudioModelClient } from "@local-agent-lab/local-model-client";

const root = path.resolve(import.meta.dirname, "..", "..");
export const defaultTrackerPath = path.resolve(
  root,
  "manual-files",
  "wordpress-blog-content-tracker.xlsx",
);
export const defaultOutputDirectory = path.resolve(root, "dist", "wordpress-blog-writer");
export const requiredTrackerHeaders = [
  "blog_id",
  "blog_topic",
  "blog_status",
  "blog_created_date",
  "blog_posted_date",
] as const;

type Header = (typeof requiredTrackerHeaders)[number];
type BlogStatus = "pending" | "complete" | "uploaded";

export interface BlogGenerator {
  generate(input: { topic: string; title: string; wordCount: number }): Promise<string>;
}
export interface BlogWriterOptions {
  readonly tracker?: string;
  readonly outputDirectory?: string;
  readonly approve?: boolean;
  readonly wordCount?: number;
  readonly model?: string;
  readonly lmStudioUrl?: string;
  readonly generator?: BlogGenerator;
  readonly now?: Date;
}
export interface BlogWriterResult {
  readonly blogId: string;
  readonly draftPath: string;
  readonly status: "draft" | "complete";
  readonly model?: string;
}

const value = (cell: ExcelJS.Cell): string => {
  const raw = cell.value;
  return raw === null || raw === undefined ? "" : String(raw).trim();
};
const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/(^-|-$)/gu, "") || "wordpress-blog";
const hasPlaceholder = (text: string): boolean =>
  /\b(?:lorem ipsum|placeholder|research needed|todo|tbd)\b/iu.test(text);
const draftIssue = (text: string, wordCount: number): string | undefined => {
  const actualWordCount = text.split(/\s+/u).filter(Boolean).length;
  if (actualWordCount < wordCount) return `it contains only ${actualWordCount} words`;
  if (hasPlaceholder(text)) return "it contains placeholder text";
  return undefined;
};
const frontMatter = (title: string, tags: readonly string[]): string =>
  `---\ntitle: "${title.replaceAll('"', "'")}"\nslug: "${slug(title)}"\nmeta_description: "${title.replaceAll('"', "'")}"\ncategories:\n  - WordPress\ntags:\n${tags.map((tag) => `  - ${tag}`).join("\n")}\n---\n`;

const isStatus = (value: string): value is BlogStatus =>
  value === "pending" || value === "complete" || value === "uploaded";

const assertValidTracker = (sheet: ExcelJS.Worksheet, column: (header: Header) => number): void => {
  const ids = new Map<string, number>();
  for (let number = 2; number <= sheet.rowCount; number += 1) {
    const row = sheet.getRow(number);
    const id = value(row.getCell(column("blog_id")));
    const topic = value(row.getCell(column("blog_topic")));
    const status = value(row.getCell(column("blog_status")));
    if (!id && !topic && !status) continue;
    if (!id) throw new Error(`Tracker row ${number} is missing blog_id.`);
    if (!topic) throw new Error(`Tracker row ${number} is missing blog_topic.`);
    if (!isStatus(status)) throw new Error(`Tracker row ${number} has an invalid blog_status.`);
    const firstRow = ids.get(id);
    if (firstRow !== undefined)
      throw new Error(`Duplicate blog_id ${id} in rows ${firstRow} and ${number}.`);
    ids.set(id, number);
  }
};

const generateWithLMStudio = async (input: {
  topic: string;
  title: string;
  wordCount: number;
  model?: string;
  lmStudioUrl?: string;
}): Promise<{ markdown: string; model: string }> => {
  const client = createLMStudioModelClient({
    config: {
      ...(input.model === undefined ? {} : { requestedModel: input.model }),
      ...(input.lmStudioUrl === undefined ? {} : { baseUrl: input.lmStudioUrl }),
    },
  });
  // The final artifact is Markdown, so request Markdown directly. The shared
  // client validates the returned text without parsing or converting it.
  const schema = z.string().min(1);
  const instruction = `Write a complete, original, publication-ready Markdown blog article about: ${input.topic}. Write at least ${input.wordCount} words for beginners. Cover the practical workflow, key decisions, common mistakes, and a realistic example where useful. Use accurate WordPress conventions and official WordPress links when relevant. Do not use filler, placeholders, bracketed research notes, or invented statistics, customer stories, or citations. Do not include YAML front matter; the agent adds it.`;
  let lastMarkdown = "";
  let lastModel = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await client.complete(
      {
        messages: [
          {
            role: "system",
            content:
              "You are an expert WordPress content writer. Return only the complete Markdown article, not JSON, a summary, or an acknowledgement.",
          },
          {
            role: "user",
            content:
              attempt === 1
                ? instruction
                : `Your previous draft was rejected because ${draftIssue(lastMarkdown, input.wordCount) ?? "it did not meet the requirements"}. Replace it with a complete article. ${instruction}`,
          },
        ],
        ...(input.model === undefined ? {} : { model: input.model }),
        temperature: 0.55,
        maxTokens: 6_000,
        structuredOutput: false,
      },
      schema,
    );
    lastMarkdown = response.value.trim();
    lastModel = response.model;
    if (draftIssue(lastMarkdown, input.wordCount) === undefined) {
      return { markdown: lastMarkdown, model: lastModel };
    }
  }
  throw new Error(
    `Blog generation failed after two attempts because ${draftIssue(lastMarkdown, input.wordCount) ?? "it did not meet the requirements"}.`,
  );
};

export const runWordPressBlogWriter = async (
  options: BlogWriterOptions = {},
): Promise<BlogWriterResult> => {
  const wordCount = options.wordCount ?? 1200;
  if (!Number.isInteger(wordCount) || wordCount < 100)
    throw new Error("Word count must be a whole number of at least 100.");
  const tracker = path.resolve(options.tracker ?? defaultTrackerPath);
  const outputDirectory = path.resolve(options.outputDirectory ?? defaultOutputDirectory);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(tracker);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("Tracker workbook has no worksheet.");
  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => headers.set(value(cell), column));
  for (const header of requiredTrackerHeaders)
    if (!headers.has(header)) throw new Error(`Tracker is missing required header: ${header}.`);
  const column = (header: Header): number => headers.get(header)!;
  assertValidTracker(sheet, column);
  let row: ExcelJS.Row | undefined;
  for (let number = 2; number <= sheet.rowCount; number += 1) {
    const candidate = sheet.getRow(number);
    if (value(candidate.getCell(column("blog_status"))) === "pending") {
      row = candidate;
      break;
    }
  }
  if (!row) throw new Error("No pending blog row is available.");
  const blogId = value(row.getCell(column("blog_id")));
  const topic = value(row.getCell(column("blog_topic")));
  const title = `A practical guide to ${topic}`;
  const generated = options.generator
    ? { markdown: await options.generator.generate({ topic, title, wordCount }), model: undefined }
    : await generateWithLMStudio({
        topic,
        title,
        wordCount,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.lmStudioUrl === undefined ? {} : { lmStudioUrl: options.lmStudioUrl }),
      });
  const article = generated.markdown;
  const issue = draftIssue(article, wordCount);
  if (issue !== undefined)
    throw new Error(`Blog generation did not meet the requested requirements because ${issue}.`);
  const markdown = `${frontMatter(title, ["wordpress", slug(topic), "beginners"])}\n# ${title}\n\n${article}\n`;
  const draftPath = path.resolve(outputDirectory, `${slug(blogId)}.md`);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(draftPath, markdown, "utf8");
  if (!options.approve)
    return {
      blogId,
      draftPath,
      status: "draft",
      ...(generated.model === undefined ? {} : { model: generated.model }),
    };
  row.getCell(column("blog_status")).value = "complete";
  row.getCell(column("blog_created_date")).value = options.now ?? new Date();
  const temporary = `${tracker}.${randomUUID()}.tmp`;
  await workbook.xlsx.writeFile(temporary);
  await rename(temporary, tracker);
  return {
    blogId,
    draftPath,
    status: "complete",
    ...(generated.model === undefined ? {} : { model: generated.model }),
  };
};
