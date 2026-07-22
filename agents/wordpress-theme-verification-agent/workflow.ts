import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

const exec = promisify(execFile);
const ignored = new Set([".git", ".cache", "cache", "node_modules", "vendor", "dist", "build"]);
export type CheckStatus = "PASS" | "FAIL" | "BLOCKED";
export type ThemeType = "classic" | "block" | "child" | "hybrid" | "unknown";
export interface ThemeCheck {
  id: string;
  status: CheckStatus;
  requirement: "required" | "recommended";
  detail: string;
  remediation?: string;
}
export interface PhpLintResult {
  path: string;
  status: CheckStatus;
  output: string;
}
export interface ThemeVerificationReport {
  themePath: string;
  themeType: ThemeType;
  status: CheckStatus;
  checks: ThemeCheck[];
  phpLint: PhpLintResult[];
  summary: string;
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
    } catch (e) {
      return { available: false, output: e instanceof Error ? e.message : String(e) };
    }
  },
  async lint(path) {
    try {
      const r = await exec("php", ["-l", path], { timeout: 15_000, windowsHide: true });
      return { ok: true, output: `${r.stdout}${r.stderr}`.trim() };
    } catch (e: unknown) {
      const x = e as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, output: `${x.stdout ?? ""}${x.stderr ?? ""}${x.message ?? ""}`.trim() };
    }
  },
};
const add = (checks: ThemeCheck[], item: ThemeCheck) => checks.push(item);
async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
async function filesBelow(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !ignored.has(entry.name)) await visit(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  await visit(root);
  return out;
}
function fields(source: string) {
  const out = new Map<string, string>();
  for (const line of source.slice(0, 8192).split(/\r?\n/u)) {
    const m = line.match(/^\s*\*?\s*([^:]+):\s*(.*?)\s*$/u);
    if (m?.[1] !== undefined && m[2] !== undefined) out.set(m[1].trim().toLowerCase(), m[2].trim());
  }
  return out;
}
function overall(checks: ThemeCheck[]): CheckStatus {
  return checks.some((c) => c.status === "FAIL")
    ? "FAIL"
    : checks.some((c) => c.status === "BLOCKED")
      ? "BLOCKED"
      : "PASS";
}

export async function verifyWordPressTheme(
  target: string,
  php: PhpRunner = systemPhp,
): Promise<ThemeVerificationReport> {
  const checks: ThemeCheck[] = [],
    phpLint: PhpLintResult[] = [];
  const supplied = resolve(target);
  let root: string;
  try {
    root = await realpath(supplied);
    if (!(await stat(root)).isDirectory()) throw new Error("not directory");
  } catch {
    add(checks, {
      id: "theme-root",
      status: "FAIL",
      requirement: "required",
      detail: `Target is not a readable theme directory: ${supplied}.`,
      remediation: "Pass the directory that directly contains style.css.",
    });
    return {
      themePath: supplied,
      themeType: "unknown",
      status: "FAIL",
      checks,
      phpLint,
      summary: "The target is not a WordPress theme directory.",
    };
  }
  const style = join(root, "style.css");
  if (!(await exists(style))) {
    add(checks, {
      id: "main-stylesheet",
      status: "FAIL",
      requirement: "required",
      detail: "style.css is missing from the target directory.",
      remediation: "Add root style.css with a Theme Name header.",
    });
    return {
      themePath: root,
      themeType: "unknown",
      status: "FAIL",
      checks,
      phpLint,
      summary:
        "The target cannot be identified as a WordPress theme because root style.css is absent.",
    };
  }
  add(checks, {
    id: "theme-root",
    status: "PASS",
    requirement: "required",
    detail: "Target is a directory with root style.css.",
  });
  const header = fields(await readFile(style, "utf8"));
  const name = header.get("theme name") ?? "";
  add(
    checks,
    name
      ? {
          id: "theme-name",
          status: "PASS",
          requirement: "required",
          detail: `Theme Name is ${name}.`,
        }
      : {
          id: "theme-name",
          status: "FAIL",
          requirement: "required",
          detail: "style.css has no non-empty Theme Name header.",
          remediation: "Set a non-empty Theme Name header.",
        },
  );
  for (const [key, pattern] of [
    ["version", /^\d+(?:\.\d+){0,2}(?:[-+][\w.-]+)?$/u],
    ["text domain", /^[a-z0-9-]+$/u],
    ["requires at least", /^\d+(?:\.\d+){0,2}$/u],
    ["requires php", /^\d+(?:\.\d+){0,2}$/u],
  ] as const) {
    const value = header.get(key);
    if (value !== undefined)
      add(
        checks,
        pattern.test(value)
          ? {
              id: `header-${key.replaceAll(" ", "-")}`,
              status: "PASS",
              requirement: "recommended",
              detail: `${key} is ${value}.`,
            }
          : {
              id: `header-${key.replaceAll(" ", "-")}`,
              status: "FAIL",
              requirement: "recommended",
              detail: `${key} is empty or malformed.`,
              remediation: `Correct ${key} or remove the field.`,
            },
      );
  }
  const template = header.get("template"),
    hasThemeJson = await exists(join(root, "theme.json")),
    hasTemplates = await exists(join(root, "templates")),
    hasIndex = await exists(join(root, "index.php"));
  const block = hasTemplates;
  const themeType: ThemeType =
    template !== undefined ? "child" : block && hasIndex ? "hybrid" : block ? "block" : "classic";
  let parentAvailable = false;
  if (template !== undefined) {
    add(
      checks,
      template
        ? {
            id: "child-template-header",
            status: "PASS",
            requirement: "required",
            detail: `Child Template is ${template}.`,
          }
        : {
            id: "child-template-header",
            status: "FAIL",
            requirement: "required",
            detail: "Child Template header is empty.",
            remediation: "Set Template to the exact parent theme directory name.",
          },
    );
    if (template) {
      const parent = join(dirname(root), template);
      const hasExactParentDirectoryName = basename(template) === template;
      if (!hasExactParentDirectoryName)
        add(checks, {
          id: "child-parent-name",
          status: "FAIL",
          requirement: "required",
          detail: "Template must contain exactly the parent theme directory name, not a path.",
          remediation: "Replace Template with only the parent theme directory name.",
        });
      parentAvailable = hasExactParentDirectoryName && (await exists(join(parent, "style.css")));
      add(
        checks,
        parentAvailable
          ? {
              id: "child-parent-availability",
              status: "PASS",
              requirement: "required",
              detail: `Parent theme is available at ${parent}.`,
            }
          : {
              id: "child-parent-availability",
              status: "BLOCKED",
              requirement: "required",
              detail: `Parent theme ${template} cannot be verified locally.`,
              remediation: `Place the parent directory named ${template} beside this child theme and rerun.`,
            },
      );
    }
  }
  if (block) {
    add(
      checks,
      hasThemeJson
        ? {
            id: "block-theme-json",
            status: "PASS",
            requirement: "required",
            detail: "theme.json exists.",
          }
        : {
            id: "block-theme-json",
            status: "FAIL",
            requirement: "required",
            detail: "Block-theme structure is present but theme.json is missing.",
            remediation: "Add theme.json at the theme root.",
          },
    );
    const index = join(root, "templates", "index.html");
    add(
      checks,
      (await exists(index))
        ? {
            id: "block-index-template",
            status: "PASS",
            requirement: "required",
            detail: "templates/index.html exists.",
          }
        : {
            id: "block-index-template",
            status: "FAIL",
            requirement: "required",
            detail: "Block fallback templates/index.html is missing.",
            remediation: "Add templates/index.html.",
          },
    );
  }
  if (!block)
    add(
      checks,
      hasIndex || parentAvailable
        ? {
            id: "classic-index-template",
            status: "PASS",
            requirement: "required",
            detail: hasIndex
              ? "index.php exists."
              : "Available parent supplies classic fallback templates.",
          }
        : {
            id: "classic-index-template",
            status: "FAIL",
            requirement: "required",
            detail: "Classic fallback index.php is missing.",
            remediation: "Add index.php or provide the referenced parent theme.",
          },
    );
  const all = await filesBelow(root),
    available = await php.available();
  if (!available.available)
    add(checks, {
      id: "php-lint-tool",
      status: "BLOCKED",
      requirement: "required",
      detail: `PHP is unavailable: ${available.output}`,
      remediation: "Install PHP or make php available on PATH, then rerun.",
    });
  else {
    add(checks, {
      id: "php-lint-tool",
      status: "PASS",
      requirement: "required",
      detail: "PHP is available for syntax linting.",
    });
    for (const path of all.filter((f) => extname(f) === ".php")) {
      const result = await php.lint(path);
      const local = relative(root, path) || basename(path);
      phpLint.push({ path: local, status: result.ok ? "PASS" : "FAIL", output: result.output });
      if (!result.ok)
        add(checks, {
          id: `php-lint-${local}`,
          status: "FAIL",
          requirement: "required",
          detail: `PHP syntax error in ${local}: ${result.output}`,
          remediation: `Correct PHP syntax in ${local}, then rerun.`,
        });
    }
  }
  for (const path of all.filter((f) => [".php", ".html", ".css", ".json"].includes(extname(f)))) {
    const content = await readFile(path, "utf8").catch(() => "");
    for (const match of content.matchAll(/get_theme_file_(?:uri|path)\(\s*['"]([^'"]+)['"]/gu)) {
      const asset = match[1];
      if (asset && !(await exists(join(root, asset))))
        add(checks, {
          id: `local-asset-${relative(root, path)}-${asset}`,
          status: "FAIL",
          requirement: "recommended",
          detail: `${relative(root, path)} references missing local theme asset ${asset}.`,
          remediation: `Add ${asset} or correct the reference.`,
        });
    }
    for (const match of content.matchAll(
      /get_template_part\(\s*['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?\s*\)/gu,
    )) {
      const slug = match[1];
      const name = match[2];
      const part = name ? `${slug}-${name}` : slug;
      const candidates = [join(root, `${part}.php`), join(root, "template-parts", `${part}.php`)];
      if (slug && !(await Promise.all(candidates.map(exists))).some(Boolean))
        add(checks, {
          id: `template-part-${relative(root, path)}-${part}`,
          status: "FAIL",
          requirement: "recommended",
          detail: `${relative(root, path)} references missing template part ${part}.`,
          remediation: `Add ${part}.php or template-parts/${part}.php, or correct the reference.`,
        });
    }
  }
  const status = overall(checks);
  const summary =
    status === "PASS"
      ? "The theme passed the structural and PHP syntax checks that ran and is safe to install or activate based solely on those checks."
      : status === "BLOCKED"
        ? "Verification is blocked for stated checks; activation safety cannot be determined solely from completed checks."
        : "The theme failed structural or PHP syntax checks and is not safe to install or activate based solely on these results.";
  return { themePath: root, themeType, status, checks, phpLint, summary };
}
