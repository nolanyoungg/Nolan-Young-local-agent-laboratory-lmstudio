import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { z } from "zod";
import { createLMStudioModelClient } from "@local-agent-lab/local-model-client";

export const requiredTrackerHeaders = [
  "Blog ID",
  "Topic",
  "Title",
  "Status",
  "Completed",
  "Scheduled Date",
  "Draft Path",
  "Email Sent At",
  "Error",
] as const;

type Header = (typeof requiredTrackerHeaders)[number];
export interface BlogDelivery {
  send(input: {
    recipient: string;
    subject: string;
    markdown: string;
    idempotencyKey: string;
  }): Promise<{ messageId: string }>;
}
export interface BlogGenerator {
  generate(input: { topic: string; title: string; wordCount: number }): Promise<string>;
}
export interface BlogWriterOptions {
  readonly tracker: string;
  readonly outputDirectory: string;
  readonly recipient: string;
  readonly approve?: boolean;
  readonly send?: boolean;
  readonly confirmBlogId?: string;
  readonly wordCount?: number;
  readonly model?: string;
  readonly lmStudioUrl?: string;
  readonly delivery?: BlogDelivery;
  readonly generator?: BlogGenerator;
  readonly now?: Date;
}
export interface BlogWriterResult {
  readonly blogId: string;
  readonly draftPath: string;
  readonly delivery: "previewed" | "sent";
  readonly model?: string;
}

const value = (cell: ExcelJS.Cell): string => {
  const raw = cell.value;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  return raw === null || raw === undefined ? "" : String(raw).trim();
};
const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/(^-|-$)/gu, "") || "wordpress-blog";
const done = (text: string): boolean => /^(true|yes|1|checked)$/iu.test(text);
const pending = (text: string): boolean => text === "" || /^pending$/iu.test(text);
const scheduled = (text: string, now: Date): boolean => !text || Date.parse(text) <= now.getTime();
const hasPlaceholder = (text: string): boolean =>
  /\b(?:lorem ipsum|placeholder|research needed|todo|tbd)\b/iu.test(text);
const frontMatter = (title: string, tags: readonly string[]): string =>
  `---\ntitle: "${title.replaceAll('"', "'")}"\nslug: "${slug(title)}"\nmeta_description: "${title.replaceAll('"', "'")}"\ncategories:\n  - WordPress\ntags:\n${tags.map((tag) => `  - ${tag}`).join("\n")}\n---\n`;

const assertValidTracker = (sheet: ExcelJS.Worksheet, column: (header: Header) => number): void => {
  const ids = new Map<string, number>();
  for (let number = 2; number <= sheet.rowCount; number += 1) {
    const row = sheet.getRow(number);
    const id = value(row.getCell(column("Blog ID")));
    if (id) {
      const firstRow = ids.get(id);
      if (firstRow !== undefined)
        throw new Error(`Duplicate Blog ID ${id} in rows ${firstRow} and ${number}.`);
      ids.set(id, number);
    }
    const date = value(row.getCell(column("Scheduled Date")));
    if (date && Number.isNaN(Date.parse(date)))
      throw new Error(`Invalid Scheduled Date in row ${number}.`);
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
  const schema = z.object({ markdown: z.string().min(1) }).strict();
  const response = await client.complete(
    {
      messages: [
        {
          role: "system",
          content:
            "You are an expert WordPress content writer. Return only JSON that matches the requested schema.",
        },
        {
          role: "user",
          content: `Write a complete, original, publication-ready Markdown blog article about: ${input.topic || input.title}. Write at least ${input.wordCount} words for beginners. Cover the practical workflow, key decisions, common mistakes, and a realistic example where useful. Use accurate WordPress conventions and official WordPress links when relevant. Do not use filler, placeholders, bracketed research notes, or invented statistics, customer stories, or citations. Do not include YAML front matter; the agent adds it.`,
        },
      ],
      ...(input.model === undefined ? {} : { model: input.model }),
      temperature: 0.55,
      maxTokens: 6_000,
      structuredOutput: true,
    },
    schema,
  );
  return { markdown: response.value.markdown.trim(), model: response.model };
};

const sendWithResend = async (input: {
  recipient: string;
  subject: string;
  markdown: string;
  idempotencyKey: string;
}): Promise<{ messageId: string }> => {
  const apiKey = process.env["RESEND_API_KEY"];
  const from = process.env["BLOG_EMAIL_SENDER"];
  if (!apiKey || !from)
    throw new Error("Email delivery needs RESEND_API_KEY and BLOG_EMAIL_SENDER.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": input.idempotencyKey,
    },
    body: JSON.stringify({
      from,
      to: [input.recipient],
      subject: input.subject,
      text: input.markdown,
      attachments: [
        { filename: "blog.md", content: Buffer.from(input.markdown).toString("base64") },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}.`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("id" in body) || typeof body.id !== "string")
    throw new Error("Email provider returned no message ID.");
  return { messageId: body.id };
};

export const runWordPressBlogWriter = async (
  options: BlogWriterOptions,
): Promise<BlogWriterResult> => {
  const wordCount = options.wordCount ?? 1200;
  if (!Number.isInteger(wordCount) || wordCount < 100)
    throw new Error("Word count must be a whole number of at least 100.");
  if (options.send && !options.approve) throw new Error("Email delivery requires --approve.");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(options.tracker);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("Tracker workbook has no worksheet.");
  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => headers.set(value(cell), column));
  for (const header of requiredTrackerHeaders)
    if (!headers.has(header)) throw new Error(`Tracker is missing required header: ${header}.`);
  const column = (header: Header): number => headers.get(header)!;
  assertValidTracker(sheet, column);
  const now = options.now ?? new Date();
  let row: ExcelJS.Row | undefined;
  for (let number = 2; number <= sheet.rowCount; number += 1) {
    const candidate = sheet.getRow(number);
    if (
      (value(candidate.getCell(column("Topic"))) || value(candidate.getCell(column("Title")))) &&
      !done(value(candidate.getCell(column("Completed")))) &&
      pending(value(candidate.getCell(column("Status")))) &&
      scheduled(value(candidate.getCell(column("Scheduled Date"))), now) &&
      value(candidate.getCell(column("Blog ID")))
    ) {
      row = candidate;
      break;
    }
  }
  if (!row) throw new Error("No eligible blog row is available.");
  const blogId = value(row.getCell(column("Blog ID")));
  if (options.send && options.confirmBlogId !== blogId)
    throw new Error(`Sending requires --confirm ${blogId}.`);
  const topic = value(row.getCell(column("Topic")));
  const suppliedTitle = value(row.getCell(column("Title")));
  const title = suppliedTitle || `A practical guide to ${topic}`;
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
  const actualWordCount = article.split(/\s+/u).filter(Boolean).length;
  if (actualWordCount < wordCount || hasPlaceholder(article))
    throw new Error(
      `Blog generation did not meet the requested word count or included placeholder text (${actualWordCount} words, placeholder text: ${hasPlaceholder(article)}).`,
    );
  const markdown = `${frontMatter(title, ["wordpress", slug(topic), "beginners"])}\n# ${title}\n\n${article}\n`;
  const draftPath = path.resolve(options.outputDirectory, `${slug(blogId)}.md`);
  await mkdir(options.outputDirectory, { recursive: true });
  await writeFile(draftPath, markdown, "utf8");
  let delivery: "previewed" | "sent" = "previewed";
  if (!options.approve)
    return {
      blogId,
      draftPath,
      delivery,
      ...(generated.model === undefined ? {} : { model: generated.model }),
    };
  if (options.send) {
    const key = createHash("sha256")
      .update(`${path.resolve(options.tracker)}:${blogId}`)
      .digest("hex");
    await (options.delivery ?? { send: sendWithResend }).send({
      recipient: options.recipient,
      subject: suppliedTitle || `Blog draft: ${blogId}`,
      markdown,
      idempotencyKey: key,
    });
    row.getCell(column("Email Sent At")).value = now.toISOString();
    delivery = "sent";
  }
  row.getCell(column("Draft Path")).value = draftPath;
  row.getCell(column("Status")).value = "completed";
  row.getCell(column("Completed")).value = true;
  row.getCell(column("Error")).value = "";
  const temporary = `${options.tracker}.${randomUUID()}.tmp`;
  await workbook.xlsx.writeFile(temporary);
  await rename(temporary, options.tracker);
  return {
    blogId,
    draftPath,
    delivery,
    ...(generated.model === undefined ? {} : { model: generated.model }),
  };
};
