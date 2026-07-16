import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type PhpRunner, verifyWordPressTheme } from "../wordpress-theme-verifier.js";

const roots: string[] = [];
const php: PhpRunner = {
  available: async () => ({ available: true, output: "PHP" }),
  lint: async (path) =>
    path.endsWith("broken.php")
      ? { ok: false, output: "Parse error" }
      : { ok: true, output: "No syntax errors" },
};
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "theme-verifier-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("wordpress theme verifier", () => {
  it("accepts a valid classic theme", async () =>
    expect(
      (
        await verifyWordPressTheme(
          await fixture({ "style.css": "/*\nTheme Name: Classic\n*/", "index.php": "<?php" }),
          php,
        )
      ).status,
    ).toBe("PASS"));
  it("detects a valid block theme", async () =>
    expect(
      (
        await verifyWordPressTheme(
          await fixture({
            "style.css": "/*\nTheme Name: Block\n*/",
            "theme.json": "{}",
            "templates/index.html": "",
          }),
          php,
        )
      ).themeType,
    ).toBe("block"));
  it("keeps a classic theme with theme.json out of block validation", async () => {
    const report = await verifyWordPressTheme(
      await fixture({
        "style.css": "/*\nTheme Name: Classic\n*/",
        "theme.json": "{}",
        "index.php": "<?php",
      }),
      php,
    );
    expect(report.themeType).toBe("classic");
    expect(report.status).toBe("PASS");
  });
  it("resolves a named template part", async () => {
    const report = await verifyWordPressTheme(
      await fixture({
        "style.css": "/*\nTheme Name: Parts\n*/",
        "index.php": "<?php get_template_part('template-parts/card', 'featured');",
        "template-parts/card-featured.php": "<?php",
      }),
      php,
    );
    expect(report.checks.some((check) => check.id.includes("template-part"))).toBe(false);
  });
  it("does not guess dynamically-composed template parts", async () => {
    const report = await verifyWordPressTheme(
      await fixture({
        "style.css": "/*\nTheme Name: Dynamic\n*/",
        "index.php": "<?php get_template_part('template-parts/card/' . $name);",
      }),
      php,
    );
    expect(report.checks.some((check) => check.id.includes("template-part"))).toBe(false);
  });
  it("accepts a child with a local parent", async () => {
    const parent = await fixture({
      "style.css": "/*\nTheme Name: Parent\n*/",
      "index.php": "<?php",
    });
    const child = join(parent, "..", "child");
    await mkdir(child);
    roots.push(child);
    await writeFile(
      join(child, "style.css"),
      `/*\nTheme Name: Child\nTemplate: ${parent.split(/[\\/]/u).pop()}\n*/`,
    );
    expect((await verifyWordPressTheme(child, php)).status).toBe("PASS");
  });
  it("fails missing stylesheet and Theme Name", async () => {
    expect((await verifyWordPressTheme(await fixture({ "index.php": "<?php" }), php)).status).toBe(
      "FAIL",
    );
    expect(
      (
        await verifyWordPressTheme(
          await fixture({ "style.css": "/* Theme Name: */", "index.php": "<?php" }),
          php,
        )
      ).checks.find((c) => c.id === "theme-name")?.status,
    ).toBe("FAIL");
  });
  it("fails missing block fallback", async () =>
    expect(
      (
        await verifyWordPressTheme(
          await fixture({ "style.css": "/*\nTheme Name: Block\n*/", "theme.json": "{}" }),
          php,
        )
      ).status,
    ).toBe("FAIL"));
  it("reports PHP syntax and local-reference failures", async () => {
    const report = await verifyWordPressTheme(
      await fixture({
        "style.css": "/*\nTheme Name: Bad\n*/",
        "index.php": "<?php get_theme_file_uri('assets/missing.png'); get_template_part('hero');",
        "broken.php": "<?php",
      }),
      php,
    );
    expect(report.phpLint.find((r) => r.path === "broken.php")?.status).toBe("FAIL");
    expect(report.checks.some((c) => c.detail.includes("assets/missing.png"))).toBe(true);
    expect(report.checks.some((c) => c.detail.includes("template part hero"))).toBe(true);
  });
});
