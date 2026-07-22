import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
for (const path of [
  "agents/github-repo-review/AGENT.md",
  "agents/wordpress-theme-verification-agent/AGENT.md",
  "agents/wordpress-theme-file-reviewer-agent/AGENT.md",
  "agents/wordpress-homepage-template-composer-agent/AGENT.md",
  "skills/evidence-based-review/SKILL.md",
  "skills/repo-auditor/SKILL.md",
  "skills/wordpress-theme-verification/SKILL.md",
  "skills/wordpress-theme-file-review/SKILL.md",
  "skills/wordpress-theme-release-readiness/SKILL.md",
  "skills/wordpress-theme-production-factory/SKILL.md",
  "skills/wordpress-theme-production-factory/references/checkpoint-artifacts.md",
  "skills/wordpress-theme-production-factory/references/evaluation-prompts.md",
  "skills/wordpress-homepage-template-composer/SKILL.md",
  "skills/wordpress-homepage-template-composer/references/section-contract.md",
  "skills/wordpress-homepage-template-composer/references/evaluation-prompts.md",
  "skills/wordpress-hook-data-flow/SKILL.md",
  "skills/woocommerce-variation-data-flow/SKILL.md",
  "skills/pressable-safe-operations/SKILL.md",
  "skills/tracking-consent-audit/SKILL.md",
  "skills/cross-platform-local-agent-lab/SKILL.md",
  "skills/dependency-clean-install-review/SKILL.md",
  "skills/wordpress-asset-build-integrity/SKILL.md",
  "skills/wordpress-plugin-release-readiness/SKILL.md",
  "skills/automation-api-pipeline-review/SKILL.md",
  "skills/wordpress-search-indexing-contract/SKILL.md",
  "skills/windows-it-evidence-triage/SKILL.md",
  "docs/skill-library.md",
  "docs/wordpress-theme-file-review-schema.md",
  "reports/agent-runs/.gitkeep",
])
  await access(resolve(root, path), constants.R_OK);
const packages = (await readdir(resolve(root, "packages"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const expected = [
  "agent-runtime",
  "filesystem-tools",
  "local-model-client",
  "shared-types",
  "tracing",
  "workspace-security",
];
if (JSON.stringify(packages) !== JSON.stringify(expected))
  throw new Error(`Unexpected packages: ${packages.join(", ")}`);
console.log(`Agent library structure verified at ${root}`);
