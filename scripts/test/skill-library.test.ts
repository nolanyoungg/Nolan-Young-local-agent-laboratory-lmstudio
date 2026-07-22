import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const requiredSkills = [
  "wordpress-theme-release-readiness",
  "wordpress-blog-writing",
  "wordpress-theme-production-factory",
  "wordpress-homepage-template-composer",
  "wordpress-hook-data-flow",
  "woocommerce-variation-data-flow",
  "pressable-safe-operations",
  "tracking-consent-audit",
  "cross-platform-local-agent-lab",
  "dependency-clean-install-review",
  "wordpress-asset-build-integrity",
  "wordpress-plugin-release-readiness",
  "automation-api-pipeline-review",
  "wordpress-search-indexing-contract",
  "windows-it-evidence-triage",
];

describe("skill library", () => {
  it("ships a complete self-contained package for every skill", async () => {
    const names = (await readdir(resolve(root, "skills"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const id of names) {
      for (const path of [
        "SKILL.md",
        "agents/openai.yaml",
        "references/output-contract.md",
        "assets/report-template.md",
        "scripts/print-report-template.mjs",
      ]) {
        const text = await readFile(resolve(root, "skills", id, path), "utf8");
        expect(text.trim()).not.toBe("");
      }
    }
  });

  it("keeps every skill discoverable and safety-scoped", async () => {
    const names = (await readdir(resolve(root, "skills"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const id of requiredSkills) {
      expect(names).toContain(id);
      const text = await readFile(resolve(root, "skills", id, "SKILL.md"), "utf8");
      expect(text).toMatch(/^# .+/m);
      expect(text).toMatch(/## Trigger/);
      expect(text).toMatch(/Output|Report/);
      expect(text).toMatch(/read-only|Read-only/i);
      expect(text).toMatch(/confirm|approved|explicit scope/i);
    }
    expect(names.every((name) => /^[a-z0-9-]+$/.test(name))).toBe(true);
  });

  it("keeps intentionally distinct trigger terms in focused skills", async () => {
    const variation = await readFile(
      resolve(root, "skills/woocommerce-variation-data-flow/SKILL.md"),
      "utf8",
    );
    const consent = await readFile(resolve(root, "skills/tracking-consent-audit/SKILL.md"), "utf8");
    const windows = await readFile(
      resolve(root, "skills/windows-it-evidence-triage/SKILL.md"),
      "utf8",
    );
    expect(variation).toMatch(/variable-product/i);
    expect(consent).toMatch(/Consent Mode/);
    expect(windows).toMatch(/Group Policy/);
  });

  it("provides resumable production-factory artifacts and evaluation coverage", async () => {
    const skillRoot = resolve(root, "skills/wordpress-theme-production-factory");
    const skill = await readFile(resolve(skillRoot, "SKILL.md"), "utf8");
    const artifacts = await readFile(
      resolve(skillRoot, "references/checkpoint-artifacts.md"),
      "utf8",
    );
    const prompts = await readFile(resolve(skillRoot, "references/evaluation-prompts.md"), "utf8");
    expect(skill).toMatch(/Phase 1/);
    expect(skill).toMatch(/Resume protocol/);
    expect(skill).toMatch(/never idle/i);
    expect(artifacts).toMatch(/Requirement matrix/);
    expect(artifacts).toMatch(/Progress log/);
    expect(prompts).toMatch(/Interrupted resume/);
    expect(prompts).toMatch(/Scope boundary/);
  });

  it("enforces the fixed nine-part homepage composition", async () => {
    const skillRoot = resolve(root, "skills/wordpress-homepage-template-composer");
    const skill = await readFile(resolve(skillRoot, "SKILL.md"), "utf8");
    const contract = await readFile(resolve(skillRoot, "references/section-contract.md"), "utf8");
    const expected = [
      "hero",
      "trust",
      "introduction",
      "services",
      "feature",
      "process",
      "results",
      "testimonials",
      "cta",
    ];
    expect((skill.match(/content-home-[a-z]+\.php/g) ?? []).length).toBe(9);
    for (const name of expected) expect(contract).toContain(`content-home-${name}.php`);
    expect(skill).toMatch(/front-page\.php/);
    expect(skill).toMatch(/read-only/i);
    expect(skill).toMatch(/BLOCKED/);
  });
});
