import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workflowPath = resolve(root, ".github", "workflows", "ci.yml");
await access(workflowPath, constants.R_OK);
const workflow = await readFile(workflowPath, "utf8");

const required = [
  "permissions:\n  contents: read",
  "concurrency:",
  "actions/checkout@v4",
  "persist-credentials: false",
  "actions/setup-node@v4",
  "node-version: 24",
  "cache: npm",
  "cache-dependency-path: package-lock.json",
  "npm ci",
  "npm run validate:ci",
  "strategy:",
  "matrix:",
  "windows-latest",
  "ubuntu-latest",
  "macos-latest",
];
for (const evidence of required)
  if (!workflow.includes(evidence))
    throw new Error(`.github/workflows/ci.yml is missing required CI operation: ${evidence}`);

if (/\b(?:npm install|npm update|npm audit fix)\b/u.test(workflow))
  throw new Error("CI must use npm ci and must not mutate dependency resolution.");
console.log("GitHub Actions CI operations verified.");
