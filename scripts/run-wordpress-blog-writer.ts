import path from "node:path";
import { runWordPressBlogWriter } from "./wordpress-blog-writer.js";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const required = (name: string): string => {
  const found = option(name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
};
const help = `Usage:\n  npm run blog-writer -- --target content.xlsx --output-directory drafts --word-count 1200 --approve\n\nOptions:\n  --target PATH              Excel content tracker\n  --output-directory PATH    Markdown draft destination\n  --word-count N             Required minimum words; default: 1200\n  --lmstudio-url URL         LM Studio OpenAI-compatible endpoint\n  --model NAME               Loaded LM Studio model\n  --recipient EMAIL          Email recipient; default: nolanyoung7@yahoo.com\n  --approve                  Mark the selected row complete\n  --send                     Send a blog.md attachment through Resend; requires --approve\n  --confirm BLOG-ID          Required exact Blog ID when sending`;

try {
  if (args.includes("--help")) {
    console.log(help);
  } else {
    const wordCount = option("--word-count");
    const confirmBlogId = option("--confirm");
    const model = option("--model");
    const lmStudioUrl = option("--lmstudio-url");
    const result = await runWordPressBlogWriter({
      tracker: path.resolve(required("--target")),
      outputDirectory: path.resolve(required("--output-directory")),
      recipient: option("--recipient") ?? "nolanyoung7@yahoo.com",
      approve: args.includes("--approve"),
      send: args.includes("--send"),
      ...(confirmBlogId === undefined ? {} : { confirmBlogId }),
      ...(wordCount === undefined ? {} : { wordCount: Number(wordCount) }),
      ...(model === undefined ? {} : { model }),
      ...(lmStudioUrl === undefined ? {} : { lmStudioUrl }),
    });
    console.log(
      `Blog ID: ${result.blogId}\nDraft: ${result.draftPath}\nDelivery: ${result.delivery}${result.model ? `\nModel: ${result.model}` : ""}`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
