import { runStagedRepositoryReview } from "./workflow.js";

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const required = (name: string) => { const value = option(name); if (!value) throw new Error(`Missing ${name}`); return value; };

try {
  const result = await runStagedRepositoryReview({ workspace: required("--workspace"), task: required("--task"), ...(option("--report-directory") ? { reportDirectory: option("--report-directory")! } : {}), ...(option("--lmstudio-url") ? { lmStudioUrl: option("--lmstudio-url")! } : {}), ...(option("--model") ? { model: option("--model")! } : {}) });
  console.log(JSON.stringify({ runPath: result.runPath, findings: result.review.findings.length, completedStages: result.review.completedStages }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2;
}
