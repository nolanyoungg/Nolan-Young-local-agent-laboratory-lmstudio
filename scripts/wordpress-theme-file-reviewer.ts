import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

const exec = promisify(execFile);
export const WORDPRESS_THEME_FILE_REVIEW_SCHEMA_VERSION = "1.0.0";
export type ReviewStatus = "PASS" | "WARN" | "FAIL" | "INFO" | "BLOCKED" | "UNVERIFIED" | "SKIPPED";
export type TargetClassification = "SINGLE_THEME_ROOT" | "THEME_COLLECTION_ROOT" | "INVALID_TARGET";
export interface Finding {
  status: ReviewStatus;
  code: string;
  path?: string;
  line?: number;
  detail: string;
  remediation?: string;
  staticInference?: boolean;
}
export interface ManifestFile {
  theme: string;
  path: string;
  extension: string;
  type: string;
  size: number;
  analysis: "ANALYZED" | "SKIPPED" | "BLOCKED";
  result: ReviewStatus;
  checks: string[];
}
export interface LocalReference {
  source: string;
  line?: number;
  target: string;
  resolution:
    | "local"
    | "missing-local"
    | "external"
    | "wordpress-core"
    | "plugin-provided"
    | "parent-theme-provided"
    | "dynamic"
    | "unresolved";
}
export interface ThemeReview {
  root: string;
  name: string;
  status: "PASS" | "WARN" | "FAIL" | "BLOCKED" | "UNVERIFIED";
  type: "classic" | "block" | "child" | "hybrid" | "unknown";
  metadata: Record<string, string>;
  manifest: ManifestFile[];
  references: LocalReference[];
  phpLint: Array<{ path: string; status: ReviewStatus; output: string }>;
  findings: Finding[];
}
export interface ThemeFileReviewReport {
  schemaVersion: string;
  executionTime: string;
  target: string;
  inputClassification: TargetClassification;
  tools: { php: "available" | "unavailable"; node: "available" };
  nonThemeDirectories: string[];
  themes: ThemeReview[];
  findings: Finding[];
  scope: string;
}

export interface PhpRunner {
  available(): Promise<{ available: boolean; output: string }>;
  lint(path: string): Promise<{ ok: boolean; output: string }>;
}
const systemPhp: PhpRunner = {
  async available() {
    try {
      const r = await exec("php", ["-v"], { timeout: 15_000, windowsHide: true });
      return { available: true, output: `${r.stdout}${r.stderr}`.trim() };
    } catch (error) {
      return { available: false, output: error instanceof Error ? error.message : String(error) };
    }
  },
  async lint(path) {
    try {
      const r = await exec("php", ["-l", path], { timeout: 15_000, windowsHide: true });
      return { ok: true, output: `${r.stdout}${r.stderr}`.trim() };
    } catch (error: unknown) {
      const e = error as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}`.trim() };
    }
  },
};
const binaryExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp3",
  ".mp4",
  ".webm",
  ".pdf",
  ".zip",
  ".gz",
  ".map",
  ".exe",
  ".dll",
  ".msi",
  ".sh",
  ".bat",
  ".cmd",
]);
const configNames = new Set([
  "package.json",
  "composer.json",
  ".eslintrc",
  ".stylelintrc",
  ".prettierrc",
  ".editorconfig",
  ".gitignore",
]);
const lineOf = (text: string, index: number) => text.slice(0, index).split(/\r?\n/u).length;
const normalize = (path: string) => path.split(sep).join("/");
const exists = async (path: string) =>
  stat(path)
    .then(() => true)
    .catch(() => false);
const fields = (source: string) => {
  const out: Record<string, string> = {};
  for (const line of source.slice(0, 8192).split(/\r?\n/u)) {
    const m = line.match(/^\s*\*?\s*([^:]+):\s*(.*?)\s*$/u);
    if (m?.[1] && m[2] !== undefined) out[m[1].trim()] = m[2].trim();
  }
  return out;
};
const statusOf = (findings: Finding[]): ThemeReview["status"] =>
  findings.some((f) => f.status === "FAIL")
    ? "FAIL"
    : findings.some((f) => f.status === "BLOCKED")
      ? "BLOCKED"
      : findings.some((f) => f.status === "UNVERIFIED")
        ? "UNVERIFIED"
        : findings.some((f) => f.status === "WARN")
          ? "WARN"
          : "PASS";
function classify(path: string) {
  const ext = extname(path).toLowerCase();
  const name = basename(path).toLowerCase();
  if (ext === ".php") return "PHP";
  if ([".css", ".scss", ".sass", ".less"].includes(ext))
    return ext === ".css" ? "CSS" : "stylesheet-source";
  if ([".js", ".mjs", ".cjs", ".ts", ".tsx"].includes(ext)) return "JavaScript/TypeScript";
  if (ext === ".json") return "JSON";
  if ([".html", ".htm"].includes(ext)) return "HTML";
  if (ext === ".xml") return "XML";
  if ([".yaml", ".yml"].includes(ext)) return "YAML";
  if ([".md", ".txt", ".text"].includes(ext)) return "documentation";
  if (binaryExtensions.has(ext)) return "binary";
  if (configNames.has(name) || name.includes("lock") || /^(vite|webpack|gulp|rollup)\./u.test(name))
    return "configuration";
  return "unknown";
}
async function inventory(root: string) {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  await visit(root);
  return out;
}
function add(findings: Finding[], finding: Finding) {
  findings.push(finding);
}
async function resolveReference(
  root: string,
  source: string,
  raw: string,
  references: LocalReference[],
  findings: Finding[],
  index = 0,
): Promise<void> {
  const line = lineOf(source, index);
  if (/^(?:https?:|\/\/|data:|#)/iu.test(raw))
    return void references.push({
      source: normalize(relative(root, source)),
      line,
      target: raw,
      resolution: "external",
    });
  if (/\$|\{|\}|<\?php|\(.*\)/u.test(raw))
    return void references.push({
      source: normalize(relative(root, source)),
      line,
      target: raw,
      resolution: "dynamic",
    });
  const target = resolve(dirname(source), raw.split(/[?#]/u)[0] ?? "");
  if (target.startsWith(`${root}${sep}`) || target === root) {
    if (await exists(target))
      references.push({
        source: normalize(relative(root, source)),
        line,
        target: normalize(relative(root, target)),
        resolution: "local",
      });
    else {
      references.push({
        source: normalize(relative(root, source)),
        line,
        target: raw,
        resolution: "missing-local",
      });
      add(findings, {
        status: "FAIL",
        code: "missing-local-reference",
        path: normalize(relative(root, source)),
        line,
        detail: `Confirmed missing local reference: ${raw}.`,
        remediation: `Add ${raw} or correct the reference.`,
      });
    }
  } else
    references.push({
      source: normalize(relative(root, source)),
      line,
      target: raw,
      resolution: "unresolved",
    });
}
async function reviewTheme(
  root: string,
  php: PhpRunner,
  parentRoot?: string,
): Promise<ThemeReview> {
  const findings: Finding[] = [],
    references: LocalReference[] = [],
    phpLint: ThemeReview["phpLint"] = [];
  const style = join(root, "style.css");
  const metadata = fields(await readFile(style, "utf8"));
  const name = metadata["Theme Name"] ?? "";
  if (!name)
    add(findings, {
      status: "FAIL",
      code: "theme-name",
      path: "style.css",
      detail: "Root style.css has no non-empty Theme Name.",
      remediation: "Set a non-empty Theme Name header.",
    });
  const hasBlockIndex = await exists(join(root, "templates", "index.html"));
  const hasTemplates = await exists(join(root, "templates"));
  const hasClassicIndex = await exists(join(root, "index.php"));
  const template = metadata["Template"];
  const type: ThemeReview["type"] = template
    ? "child"
    : hasTemplates && hasClassicIndex
      ? "hybrid"
      : hasTemplates
        ? "block"
        : hasClassicIndex
          ? "classic"
          : "unknown";
  if (hasTemplates && !hasBlockIndex)
    add(findings, {
      status: "FAIL",
      code: "block-index-template",
      path: "templates/index.html",
      detail:
        "A block-theme templates directory is present but its required fallback templates/index.html is missing.",
      remediation: "Add templates/index.html.",
    });
  if (!hasTemplates && !hasClassicIndex && !template)
    add(findings, {
      status: "FAIL",
      code: "classic-index-template",
      detail: "Classic fallback index.php is missing.",
      remediation: "Add index.php.",
    });
  if (template !== undefined) {
    if (!template || basename(template) !== template)
      add(findings, {
        status: "FAIL",
        code: "child-template",
        path: "style.css",
        detail: "Child Template must be a non-empty parent directory name.",
        remediation: "Set Template to the exact parent directory name.",
      });
    else if (parentRoot && (await exists(join(parentRoot, template, "style.css"))))
      add(findings, {
        status: "INFO",
        code: "parent-found",
        detail: `Parent theme ${template} is available locally.`,
      });
    else
      add(findings, {
        status: "UNVERIFIED",
        code: "parent-unavailable",
        detail: `Parent theme ${template} is unavailable; parent-dependent behavior cannot be reviewed.`,
      });
  }
  const files = await inventory(root);
  const phpAvailable = await php.available();
  if (!phpAvailable.available && files.some((f) => extname(f).toLowerCase() === ".php"))
    add(findings, {
      status: "BLOCKED",
      code: "php-lint-tool",
      detail: `PHP linting is unavailable: ${phpAvailable.output}`,
    });
  const manifest: ManifestFile[] = [];
  for (const file of files) {
    const rel = normalize(relative(root, file));
    const typeName = classify(file);
    const size = (await stat(file)).size;
    const checks: string[] = [];
    let result: ReviewStatus = "PASS";
    let analysis: ManifestFile["analysis"] = "ANALYZED";
    if (typeName === "binary") {
      analysis = "SKIPPED";
      result = size === 0 ? "WARN" : "SKIPPED";
      checks.push("safe-metadata");
      if (size === 0)
        add(findings, {
          status: "WARN",
          code: "empty-binary",
          path: rel,
          detail: "Binary asset is empty.",
        });
      if ([".exe", ".dll", ".msi", ".sh", ".bat", ".cmd"].includes(extname(file).toLowerCase()))
        add(findings, {
          status: "WARN",
          code: "executable-like-file",
          path: rel,
          detail: "Executable-like file is stored in the theme directory and was not executed.",
        });
    } else {
      let text = "";
      try {
        text = await readFile(file, "utf8");
      } catch {
        analysis = "BLOCKED";
        result = "BLOCKED";
        add(findings, {
          status: "BLOCKED",
          code: "unreadable-file",
          path: rel,
          detail: "File could not be read safely.",
        });
      }
      if (text) {
        if (
          typeName === "JSON" ||
          (typeName === "configuration" && basename(file) === "package.json")
        ) {
          checks.push("json-parse");
          try {
            const parsed: unknown = JSON.parse(text);
            if (
              (basename(file) === "theme.json" || rel.startsWith("styles/")) &&
              (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            ) {
              result = "WARN";
              add(findings, {
                status: "WARN",
                code: "suspicious-theme-json-shape",
                path: rel,
                detail: "Theme configuration JSON is valid but its root is not an object.",
                staticInference: true,
              });
            }
          } catch (error) {
            result = "FAIL";
            add(findings, {
              status: "FAIL",
              code: "invalid-json",
              path: rel,
              detail: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
              remediation: "Correct JSON syntax.",
            });
          }
        }
        if (typeName === "PHP") {
          checks.push("php-lint", "php-local-references");
          if (phpAvailable.available) {
            const lint = await php.lint(file);
            phpLint.push({ path: rel, status: lint.ok ? "PASS" : "FAIL", output: lint.output });
            if (!lint.ok) {
              result = "FAIL";
              add(findings, {
                status: "FAIL",
                code: "php-syntax",
                path: rel,
                detail: lint.output,
                remediation: "Correct the PHP syntax error.",
              });
            }
          } else result = "BLOCKED";
          for (const m of text.matchAll(
            /\b(?:require|require_once|include|include_once)\s*\(?\s*['"]([^'"]+)['"]/gu,
          ))
            await resolveReference(root, file, m[1]!, references, findings, m.index);
          for (const m of text.matchAll(
            /get_template_part\(\s*['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/gu,
          )) {
            const part = `${m[1]}${m[2] ? `-${m[2]}` : ""}.php`;
            const candidates = [join(root, part), join(root, "template-parts", part)];
            if (!(await Promise.all(candidates.map(exists))).some(Boolean))
              add(findings, {
                status: "FAIL",
                code: "missing-template-part",
                path: rel,
                line: lineOf(text, m.index),
                detail: `Confirmed missing local template part ${part}.`,
                remediation: `Add ${part} or template-parts/${part}.`,
              });
          }
          for (const m of text.matchAll(/get_(?:theme_)?file_(?:uri|path)\(\s*['"]([^'"]+)['"]/gu))
            await resolveReference(root, file, m[1]!, references, findings, m.index);
          if (
            /\$_(?:GET|POST|REQUEST)\b/u.test(text) &&
            /\becho\s+\$_(?:GET|POST|REQUEST)\b/u.test(text)
          )
            add(findings, {
              status: "WARN",
              code: "unsafe-request-output",
              path: rel,
              detail: "Static pattern suggests request data is output without visible escaping.",
              staticInference: true,
            });
        }
        if (typeName === "CSS" || typeName === "stylesheet-source") {
          checks.push("css-local-urls");
          for (const m of text.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/gu))
            await resolveReference(root, file, m[1]!, references, findings, m.index);
        }
        if (typeName === "JavaScript/TypeScript") {
          checks.push("js-local-imports");
          for (const m of text.matchAll(
            /(?:import\s*(?:[^'"()]+?\s+from\s*)?|require\()\s*['"]([^'"]+)['"]/gu,
          )) {
            const raw = m[1]!;
            if (raw.startsWith(".")) {
              const candidate = resolve(dirname(file), raw);
              const choices = [
                candidate,
                `${candidate}.js`,
                `${candidate}.ts`,
                join(candidate, "index.js"),
              ];
              if (!(await Promise.all(choices.map(exists))).some(Boolean))
                await resolveReference(root, file, raw, references, findings, m.index);
            }
          }
        }
        if (typeName === "JavaScript/TypeScript") {
          checks.push("js-local-imports");
          if ([".ts", ".tsx"].includes(extname(file).toLowerCase())) {
            result = "BLOCKED";
            add(findings, {
              status: "BLOCKED",
              code: "typescript-tooling-unavailable",
              path: rel,
              detail: "No project TypeScript checker is invoked by the read-only reviewer.",
            });
          }
          for (const m of text.matchAll(
            /(?:import\s*(?:[^'"()]+?\s+from\s*)?|require\()\s*['"]([^'"]+)['"]/gu,
          )) {
            const raw = m[1]!;
            if (raw.startsWith(".")) {
              const candidate = resolve(dirname(file), raw);
              const choices = [
                candidate,
                `${candidate}.js`,
                `${candidate}.ts`,
                join(candidate, "index.js"),
              ];
              if (!(await Promise.all(choices.map(exists))).some(Boolean))
                await resolveReference(root, file, raw, references, findings, m.index);
            }
          }
        }
        if (typeName === "HTML" && (rel.startsWith("templates/") || rel.startsWith("parts/"))) {
          checks.push("block-markup-balance");
          const starts = [...text.matchAll(/<!--\s+wp:[^\s]+/gu)].length,
            ends = [...text.matchAll(/<!--\s+\/wp:[^\s]+\s+-->/gu)].length;
          if (ends > starts) {
            result = "WARN";
            add(findings, {
              status: "WARN",
              code: "suspicious-block-markup",
              path: rel,
              detail: "Block closing comments exceed opening comments.",
            });
          }
        }
      }
    }
    manifest.push({
      theme: name || basename(root),
      path: rel,
      extension: extname(file).toLowerCase(),
      type: typeName,
      size,
      analysis,
      result,
      checks,
    });
  }
  const status = statusOf(findings);
  return {
    root,
    name: name || basename(root),
    status,
    type,
    metadata,
    manifest,
    references,
    phpLint,
    findings,
  };
}
export async function reviewWordPressThemeFiles(
  target: string,
  php: PhpRunner = systemPhp,
): Promise<ThemeFileReviewReport> {
  const supplied = resolve(target);
  const executionTime = new Date().toISOString();
  let root: string;
  try {
    root = await realpath(supplied);
    if (!(await stat(root)).isDirectory()) throw new Error("not directory");
  } catch {
    const finding: Finding = {
      status: "FAIL",
      code: "invalid-target",
      detail: `Target is not a readable directory: ${supplied}.`,
    };
    return {
      schemaVersion: WORDPRESS_THEME_FILE_REVIEW_SCHEMA_VERSION,
      executionTime,
      target: supplied,
      inputClassification: "INVALID_TARGET",
      tools: { php: "unavailable", node: "available" },
      nonThemeDirectories: [],
      themes: [],
      findings: [finding],
      scope:
        "Static and syntax-focused review only; no runtime, visual, or production-readiness certification.",
    };
  }
  const validTheme = async (dir: string) => {
    const style = join(dir, "style.css");
    if (!(await exists(style))) return false;
    try {
      return Boolean(fields(await readFile(style, "utf8"))["Theme Name"]);
    } catch {
      return false;
    }
  };
  const direct = await readdir(root, { withFileTypes: true });
  let classification: TargetClassification;
  let themeRoots: string[];
  let nonThemeDirectories: string[] = [];
  if (await validTheme(root)) {
    classification = "SINGLE_THEME_ROOT";
    themeRoots = [root];
  } else {
    themeRoots = [];
    for (const entry of direct.filter((e) => e.isDirectory())) {
      const child = join(root, entry.name);
      if (await validTheme(child)) themeRoots.push(child);
      else nonThemeDirectories.push(entry.name);
    }
    classification = themeRoots.length ? "THEME_COLLECTION_ROOT" : "INVALID_TARGET";
  }
  const phpInfo = await php.available();
  if (!themeRoots.length) {
    const finding: Finding = {
      status: "FAIL",
      code: "invalid-target",
      detail: "No root-level recognizable theme or immediate child theme root was identified.",
    };
    return {
      schemaVersion: WORDPRESS_THEME_FILE_REVIEW_SCHEMA_VERSION,
      executionTime,
      target: root,
      inputClassification: classification,
      tools: { php: phpInfo.available ? "available" : "unavailable", node: "available" },
      nonThemeDirectories,
      themes: [],
      findings: [finding],
      scope:
        "Static and syntax-focused review only; no runtime, visual, or production-readiness certification.",
    };
  }
  const themes = await Promise.all(
    themeRoots.map((themeRoot) =>
      reviewTheme(themeRoot, php, classification === "THEME_COLLECTION_ROOT" ? root : undefined),
    ),
  );
  return {
    schemaVersion: WORDPRESS_THEME_FILE_REVIEW_SCHEMA_VERSION,
    executionTime,
    target: root,
    inputClassification: classification,
    tools: { php: phpInfo.available ? "available" : "unavailable", node: "available" },
    nonThemeDirectories,
    themes,
    findings: themes.flatMap((theme) => theme.findings),
    scope:
      "Static and syntax-focused review only. It does not execute theme code or prove visual correctness, runtime behavior, complete security, or production readiness.",
  };
}
export function markdownThemeFileReview(report: ThemeFileReviewReport) {
  const lines = [
    "# WordPress Theme File Review",
    "",
    `- Schema: ${report.schemaVersion}`,
    `- Target: ${report.target}`,
    `- Executed: ${report.executionTime}`,
    `- Input classification: ${report.inputClassification}`,
    `- PHP: ${report.tools.php}`,
    "",
    "## Theme discovery",
    "",
    `- Themes: ${report.themes.length}`,
    `- Non-theme directories: ${report.nonThemeDirectories.join(", ") || "None"}`,
  ];
  for (const theme of report.themes) {
    lines.push(
      "",
      `## ${theme.name} — ${theme.status}`,
      "",
      `- Root: ${theme.root}`,
      `- Architecture: ${theme.type}`,
      `- Files inventoried: ${theme.manifest.length}`,
      `- Metadata: ${
        Object.entries(theme.metadata)
          .map(([k, v]) => `${k}=${v}`)
          .join("; ") || "None"
      }`,
      "",
      "### Findings",
      "",
      ...(theme.findings.map(
        (f) =>
          `- **${f.status}** ${f.path ? `${f.path}${f.line ? `:${f.line}` : ""}: ` : ""}${f.detail}${f.remediation ? ` Remediation: ${f.remediation}` : ""}`,
      ) || ["- None."]),
      "",
      "### PHP lint",
      "",
      ...(theme.phpLint.map((f) => `- **${f.status}** ${f.path}: ${f.output}`) || [
        "- No PHP files.",
      ]),
      "",
      "### Local references",
      "",
      ...(theme.references.map(
        (r) => `- ${r.source}${r.line ? `:${r.line}` : ""} → ${r.target} (${r.resolution})`,
      ) || ["- None."]),
      "",
      "### Full file manifest",
      "",
      "| Path | Type | Size | Analysis | Result |",
      "| --- | --- | ---: | --- | --- |",
      ...theme.manifest.map(
        (f) => `| ${f.path} | ${f.type} | ${f.size} | ${f.analysis} | ${f.result} |`,
      ),
    );
  }
  lines.push("", "## Scope", "", report.scope);
  return `${lines.join("\n")}\n`;
}
