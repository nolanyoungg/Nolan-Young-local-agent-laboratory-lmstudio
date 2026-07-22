import path from "node:path";
import { defaultOutputDirectory, defaultTrackerPath, runWordPressBlogWriter } from "./workflow.js";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const help = `Usage:\n  npm run wordpress-blog-writer-agent -- --word-count 1200 --approve\n\nDefaults:\n  --target ${defaultTrackerPath}\n  --output-directory ${defaultOutputDirectory}\n\nOptions:\n  --initialize-tracker [PATH] Create an empty centralized tracker\n  --target PATH              Excel blog tracker override\n  --output-directory PATH    Markdown draft destination override\n  --word-count N             Required minimum words; default: 1200\n  --lmstudio-url URL         LM Studio OpenAI-compatible endpoint\n  --model NAME               Loaded LM Studio model\n  --approve                  Mark the selected pending row complete`;

try {
  if (args.includes("--help")) console.log(help);
  else if (args[0] === "--initialize-tracker") {
    process.argv = [...process.argv.slice(0, 2), ...args.slice(1)];
    await import("./initialize-tracker.js");
  } else {
    const wordCount = option("--word-count");
    const result = await runWordPressBlogWriter({
      ...(option("--target") === undefined ? {} : { tracker: path.resolve(option("--target")!) }),
      ...(option("--output-directory") === undefined
        ? {}
        : { outputDirectory: path.resolve(option("--output-directory")!) }),
      approve: args.includes("--approve"),
      ...(wordCount === undefined ? {} : { wordCount: Number(wordCount) }),
      ...(option("--model") === undefined ? {} : { model: option("--model")! }),
      ...(option("--lmstudio-url") === undefined ? {} : { lmStudioUrl: option("--lmstudio-url")! }),
    });
    console.log(
      `Blog ID: ${result.blogId}\nDraft: ${result.draftPath}\nStatus: ${result.status}${result.model ? `\nModel: ${result.model}` : ""}`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
