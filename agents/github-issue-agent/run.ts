import { publishReview } from "./workflow.js";
const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const required = (name: string) => { const value = option(name); if (!value) throw new Error(`Missing ${name}`); return value; };
try { const result = await publishReview({ reviewPath: required("--review-result"), workspace: option("--workspace") ?? ".", ...(option("--repository") ? { repository: option("--repository")! } : {}), publish: args.includes("--publish") }); console.log(JSON.stringify(result, null, 2)); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }