import { minimatch } from "minimatch";
import path from "node:path";

import { PathPolicyError, PathValidationError } from "./errors.js";

export const DEFAULT_MAX_RELATIVE_PATH_LENGTH = 1_024;
export const DEFAULT_MAX_PATH_SEGMENT_LENGTH = 255;
export const DEFAULT_MAX_PATH_DEPTH = 64;

export const DEFAULT_FORBIDDEN_GLOBS = [
  ".git",
  ".git/**",
  "**/.git",
  "**/.git/**",
  ".env",
  ".env*",
  ".env.*",
  "**/.env",
  "**/.env*",
  "**/.env.*",
  "node_modules",
  "node_modules/**",
  "**/node_modules",
  "**/node_modules/**",
  "reports",
  "reports/**",
  ".local-agent-lab",
  ".local-agent-lab/**",
  "**/.ssh",
  "**/.ssh/**",
  ".npm",
  ".npm/**",
  "**/.npm",
  "**/.npm/**",
  ".pnpm-store",
  ".pnpm-store/**",
  "**/.pnpm-store",
  "**/.pnpm-store/**",
  ".yarn/cache",
  ".yarn/cache/**",
  "**/.yarn/cache",
  "**/.yarn/cache/**",
  ".cache",
  ".cache/**",
  "**/.cache",
  "**/.cache/**",
  ".next",
  ".next/**",
  "**/.next",
  "**/.next/**",
  ".turbo",
  ".turbo/**",
  "**/.turbo",
  "**/.turbo/**",
  ".vite",
  ".vite/**",
  "**/.vite",
  "**/.vite/**",
  "**/.eslintcache",
  "**/*.cache",
  "**/*.{pem,key,pfx,p12,crt,cer,der}",
  "**/id_{rsa,dsa,ecdsa,ed25519}",
  "**/id_{rsa,dsa,ecdsa,ed25519}.pub",
  "**/credentials",
  "**/credentials.*",
  "**/.credentials",
  "**/.credentials.*",
  "**/secrets.*",
  "**/.secrets.*",
  "**/service-account*.json",
] as const;

const WINDOWS_INVALID_CHARACTERS = /[<>:"|?*]/u;
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

export interface PathLimits {
  readonly maxDepth?: number;
  readonly maxPathLength?: number;
  readonly maxSegmentLength?: number;
}

export interface PathPolicyOptions extends PathLimits {
  readonly deleteGlobs?: readonly string[];
  readonly forbiddenGlobs?: readonly string[];
  readonly readGlobs?: readonly string[];
  readonly writeGlobs?: readonly string[];
}

export type PathOperation = "delete" | "read" | "write";

function validateLimits(limits: Required<PathLimits>): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
}

export function validateRelativePath(input: string, limits: PathLimits = {}): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new PathValidationError("INVALID_PATH", "Path must be a non-empty string", input);
  }

  const resolvedLimits: Required<PathLimits> = {
    maxDepth: limits.maxDepth ?? DEFAULT_MAX_PATH_DEPTH,
    maxPathLength: limits.maxPathLength ?? DEFAULT_MAX_RELATIVE_PATH_LENGTH,
    maxSegmentLength: limits.maxSegmentLength ?? DEFAULT_MAX_PATH_SEGMENT_LENGTH,
  };
  validateLimits(resolvedLimits);

  if (
    [...input].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new PathValidationError("MALFORMED_PATH", "Path contains a control character", input);
  }
  if (input.trim() !== input) {
    throw new PathValidationError(
      "MALFORMED_PATH",
      "Path must not have leading or trailing whitespace",
      input,
    );
  }
  if (input.length > resolvedLimits.maxPathLength) {
    throw new PathValidationError(
      "PATH_TOO_LONG",
      `Path exceeds ${resolvedLimits.maxPathLength} characters`,
      input,
    );
  }

  const portable = input.replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(portable) ||
    path.win32.isAbsolute(input) ||
    /^[a-zA-Z]:/u.test(input) ||
    portable.startsWith("//")
  ) {
    throw new PathValidationError("ABSOLUTE_PATH", "Only relative paths are allowed", input);
  }

  if (portable === ".") {
    return portable;
  }
  if (portable.endsWith("/") || portable.includes("//")) {
    throw new PathValidationError("MALFORMED_PATH", "Path contains an empty segment", input);
  }

  const segments = portable.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new PathValidationError("PATH_TRAVERSAL", "Parent traversal is not allowed", input);
  }
  if (segments.some((segment) => segment === "." || segment.length === 0)) {
    throw new PathValidationError("MALFORMED_PATH", "Path contains an ambiguous segment", input);
  }
  if (segments.length > resolvedLimits.maxDepth) {
    throw new PathValidationError(
      "PATH_TOO_LONG",
      `Path exceeds ${resolvedLimits.maxDepth} segments`,
      input,
    );
  }

  for (const segment of segments) {
    if (segment.length > resolvedLimits.maxSegmentLength) {
      throw new PathValidationError(
        "PATH_TOO_LONG",
        `Path segment exceeds ${resolvedLimits.maxSegmentLength} characters`,
        input,
      );
    }
    if (
      WINDOWS_INVALID_CHARACTERS.test(segment) ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      WINDOWS_RESERVED_NAME.test(segment)
    ) {
      throw new PathValidationError(
        "MALFORMED_PATH",
        `Path segment is not portable to Windows: ${segment}`,
        input,
      );
    }
  }

  return segments.join("/");
}

function normalizePatterns(patterns: readonly string[], label: string): readonly string[] {
  return Object.freeze(
    patterns.map((pattern) => {
      const normalized = pattern.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
      if (normalized.length === 0 || normalized.startsWith("!") || normalized.includes("\0")) {
        throw new TypeError(`${label} contains an invalid glob pattern`);
      }
      return normalized;
    }),
  );
}

function matchesAny(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    minimatch(relativePath, pattern, {
      dot: true,
      // Workspaces are operated on Windows even when tests run elsewhere.
      nocase: true,
      nocomment: true,
      nonegate: true,
    }),
  );
}

export class PathPolicy {
  readonly #deleteGlobs: readonly string[];
  readonly #forbiddenGlobs: readonly string[];
  readonly #limits: Required<PathLimits>;
  readonly #readGlobs: readonly string[];
  readonly #writeGlobs: readonly string[];

  public constructor(options: PathPolicyOptions = {}) {
    this.#limits = {
      maxDepth: options.maxDepth ?? DEFAULT_MAX_PATH_DEPTH,
      maxPathLength: options.maxPathLength ?? DEFAULT_MAX_RELATIVE_PATH_LENGTH,
      maxSegmentLength: options.maxSegmentLength ?? DEFAULT_MAX_PATH_SEGMENT_LENGTH,
    };
    validateLimits(this.#limits);
    this.#readGlobs = normalizePatterns(options.readGlobs ?? ["**", "**/*"], "readGlobs");
    this.#writeGlobs = normalizePatterns(options.writeGlobs ?? ["**", "**/*"], "writeGlobs");
    this.#deleteGlobs = normalizePatterns(options.deleteGlobs ?? [], "deleteGlobs");
    this.#forbiddenGlobs = normalizePatterns(
      [...DEFAULT_FORBIDDEN_GLOBS, ...(options.forbiddenGlobs ?? [])],
      "forbiddenGlobs",
    );
  }

  public normalize(relativePath: string): string {
    return validateRelativePath(relativePath, this.#limits);
  }

  public assertAllowed(relativePath: string, operation: PathOperation): string {
    const normalized = this.normalize(relativePath);
    if (matchesAny(normalized, this.#forbiddenGlobs)) {
      throw new PathPolicyError(
        "PATH_FORBIDDEN",
        `Protected path is forbidden for ${operation}: ${normalized}`,
        normalized,
      );
    }

    const allowedGlobs =
      operation === "read"
        ? this.#readGlobs
        : operation === "write"
          ? this.#writeGlobs
          : this.#deleteGlobs;
    if (!matchesAny(normalized, allowedGlobs)) {
      const code =
        operation === "read"
          ? "READ_DENIED"
          : operation === "write"
            ? "WRITE_DENIED"
            : "DELETE_DENIED";
      throw new PathPolicyError(
        code,
        `${operation} access is not allowed: ${normalized}`,
        normalized,
      );
    }
    return normalized;
  }

  public isAllowed(relativePath: string, operation: PathOperation): boolean {
    try {
      this.assertAllowed(relativePath, operation);
      return true;
    } catch (error) {
      if (error instanceof PathPolicyError || error instanceof PathValidationError) {
        return false;
      }
      throw error;
    }
  }
}
