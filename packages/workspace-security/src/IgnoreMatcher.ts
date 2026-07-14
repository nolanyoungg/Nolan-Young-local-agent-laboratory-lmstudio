import { minimatch } from "minimatch";

import { validateRelativePath } from "./PathPolicy.js";

interface IgnoreRule {
  readonly negated: boolean;
  readonly pattern: string;
}

function parseRule(line: string): IgnoreRule | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return undefined;
  }

  const negated = trimmed.startsWith("!");
  let pattern = (negated ? trimmed.slice(1) : trimmed).replaceAll("\\", "/");
  if (pattern.length === 0 || pattern.includes("\0")) {
    throw new TypeError("Ignore pattern must not be empty or contain a null byte");
  }
  pattern = pattern.replace(/^\//u, "");
  if (pattern.endsWith("/")) {
    pattern = `${pattern}**`;
  }
  if (!pattern.includes("/")) {
    pattern = `**/${pattern}`;
  }

  return { negated, pattern };
}

export class IgnoreMatcher {
  readonly #rules: readonly IgnoreRule[];

  public constructor(patterns: readonly string[] = []) {
    this.#rules = Object.freeze(
      patterns.map(parseRule).filter((rule): rule is IgnoreRule => rule !== undefined),
    );
  }

  public static fromText(contents: string): IgnoreMatcher {
    return new IgnoreMatcher(contents.split(/\r?\n/u));
  }

  public isIgnored(relativePath: string): boolean {
    const withoutTrailingSlash = relativePath.replace(/[\\/]+$/u, "") || ".";
    const normalized = validateRelativePath(withoutTrailingSlash);
    let ignored = false;

    for (const rule of this.#rules) {
      if (
        minimatch(normalized, rule.pattern, {
          dot: true,
          // Match the target Windows filesystem's case-insensitive semantics.
          nocase: true,
          nocomment: true,
          nonegate: true,
        })
      ) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  }

  public ignores(relativePath: string): boolean {
    return this.isIgnored(relativePath);
  }

  public filter(relativePaths: readonly string[]): readonly string[] {
    return relativePaths.filter((relativePath) => !this.isIgnored(relativePath));
  }
}
