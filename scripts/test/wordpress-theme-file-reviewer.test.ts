import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { markdownThemeFileReview, reviewWordPressThemeFiles, type PhpRunner } from "../wordpress-theme-file-reviewer.js";

const php: PhpRunner = { available: async () => ({ available: true, output: "PHP" }), lint: async (path) => ({ ok: !path.endsWith("bad.php"), output: path.endsWith("bad.php") ? "syntax error" : "No syntax errors" }) };
async function fixture(files: Record<string, string | Buffer>) { const root = await mkdtemp(join(tmpdir(), "wp-file-review-")); for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); } return root; }

describe("WordPress theme file reviewer", () => {
  it("reviews a floating classic theme and inventories binary and unknown files", async () => {
    const root = await fixture({ "style.css": "/*\nTheme Name: Floating\n*/", "index.php": "<?php", "assets/a.png": Buffer.from([1]), "odd.xyz": "x" });
    const report = await reviewWordPressThemeFiles(root, php);
    expect(report.inputClassification).toBe("SINGLE_THEME_ROOT");
    expect(report.themes[0]?.manifest).toHaveLength(4);
    expect(report.themes[0]?.manifest.some((file) => file.type === "binary")).toBe(true);
    expect(markdownThemeFileReview(report)).toContain("Full file manifest");
  });
  it("discovers direct-child themes and leaves unrelated directories alone", async () => {
    const root = await fixture({ "one/style.css": "Theme Name: One", "one/index.php": "<?php", "two/style.css": "Theme Name: Two", "two/templates/index.html": "<!-- wp:group -->", "notes/readme.txt": "not a theme" });
    const report = await reviewWordPressThemeFiles(root, php);
    expect(report.inputClassification).toBe("THEME_COLLECTION_ROOT");
    expect(report.themes).toHaveLength(2);
    expect(report.nonThemeDirectories).toContain("notes");
  });
  it("reports malformed JSON, local missing references, missing block fallback, and PHP errors", async () => {
    const root = await fixture({ "style.css": "Theme Name: Broken", "templates/page.html": "<!-- /wp:group -->", "theme.json": "{bad", "bad.php": "<?php", "functions.php": "<?php require 'missing.php'; get_template_part('template-parts/nope'); get_theme_file_uri('assets/missing.css');", "assets/site.css": "a{background:url('missing.png')}" });
    const report = await reviewWordPressThemeFiles(root, php);
    const codes = report.themes[0]?.findings.map((finding) => finding.code) ?? [];
    expect(codes).toEqual(expect.arrayContaining(["block-index-template", "invalid-json", "php-syntax", "missing-local-reference", "missing-template-part"]));
  });
  it("marks PHP lint as blocked when the tool is unavailable", async () => {
    const root = await fixture({ "style.css": "Theme Name: Toolless", "index.php": "<?php" });
    const report = await reviewWordPressThemeFiles(root, { available: async () => ({ available: false, output: "missing" }), lint: async () => ({ ok: false, output: "unused" }) });
    expect(report.themes[0]?.findings.some((finding) => finding.status === "BLOCKED")).toBe(true);
  });
});
