import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

import { ReleaseEngineerError } from "./errors.js";
import type { ReleasePolicies } from "./types.js";

const MAX_POLICY_BYTES = 262_144;

const GlobSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.includes("\0") && !value.startsWith("!"), {
    message: "glob must not contain NUL or negation",
  });

const CheckPolicySchema = z
  .object({
    requiredPackageFields: z.array(z.string().min(1).max(128)).max(128),
    requiredFiles: z.array(z.string().min(1).max(1_024)).max(1_000),
    forbiddenGlobs: z.array(GlobSchema).max(2_000),
  })
  .strict();

const PackagePolicySchema = z
  .object({
    include: z.array(GlobSchema).min(1).max(2_000),
    exclude: z.array(GlobSchema).max(2_000),
    maximumEntries: z.number().int().min(1).max(100_000).default(10_000),
    maximumArchiveBytes: z
      .number()
      .int()
      .min(1)
      .max(10 * 1_073_741_824)
      .default(1_073_741_824),
  })
  .strict();

const PermissionPolicySchema = z
  .object({
    repairer: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/u)).max(64),
    reviewer: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/u)).max(64),
  })
  .strict();

export interface PolicySelection {
  readonly checkPolicyPath?: string;
  readonly packagePolicyPath?: string;
}

export interface ApplicationLocations {
  readonly applicationRoot: string;
  readonly laboratoryRoot: string;
}

async function findApplicationRoot(): Promise<string> {
  let candidate = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth += 1) {
    const manifestPath = path.join(candidate, "package.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
      if (
        typeof manifest === "object" &&
        manifest !== null &&
        !Array.isArray(manifest) &&
        (manifest as Record<string, unknown>)["name"] === "@local-agent-lab/release-engineer"
      ) {
        return await realpath(candidate);
      }
    } catch {
      // Continue toward the package root. No target workspace is consulted.
    }
    candidate = path.dirname(candidate);
  }
  throw new ReleaseEngineerError(
    "APPLICATION_ROOT_NOT_FOUND",
    "The release-engineer application root could not be located.",
    "configuration",
  );
}

export async function resolveApplicationLocations(): Promise<ApplicationLocations> {
  const applicationRoot = await findApplicationRoot();
  const laboratoryRoot = await realpath(path.resolve(applicationRoot, "../.."));
  return { applicationRoot, laboratoryRoot };
}

export async function loadLaboratoryEnvironment(): Promise<ApplicationLocations> {
  const locations = await resolveApplicationLocations();
  loadDotEnv({
    path: path.join(locations.laboratoryRoot, ".env"),
    override: false,
    quiet: true,
  });
  return locations;
}

async function loadTrustedJson<T>(
  selectedPath: string,
  schema: z.ZodType<T>,
  label: string,
): Promise<{ readonly value: T; readonly canonicalPath: string }> {
  const absolutePath = path.resolve(selectedPath);
  let canonicalPath: string;
  try {
    const stat = await lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ReleaseEngineerError(
        "POLICY_NOT_REGULAR_FILE",
        `${label} must be a regular, non-symlink file.`,
        "configuration",
      );
    }
    if (stat.size > MAX_POLICY_BYTES) {
      throw new ReleaseEngineerError(
        "POLICY_TOO_LARGE",
        `${label} exceeds ${MAX_POLICY_BYTES} bytes.`,
        "configuration",
      );
    }
    canonicalPath = await realpath(absolutePath);
  } catch (error) {
    if (error instanceof ReleaseEngineerError) throw error;
    throw new ReleaseEngineerError(
      "POLICY_UNREADABLE",
      `${label} could not be read.`,
      "configuration",
      { cause: error },
    );
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(await readFile(canonicalPath, "utf8")) as unknown;
  } catch (error) {
    throw new ReleaseEngineerError(
      "POLICY_INVALID_JSON",
      `${label} is not valid JSON.`,
      "configuration",
      { cause: error },
    );
  }
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.code}`)
      .join("; ");
    throw new ReleaseEngineerError(
      "POLICY_INVALID",
      `${label} failed schema validation (${issues}).`,
      "configuration",
    );
  }
  return { value: parsed.data, canonicalPath };
}

export async function loadReleasePolicies(
  selection: PolicySelection = {},
): Promise<ReleasePolicies> {
  const { applicationRoot } = await resolveApplicationLocations();
  const checksPath =
    selection.checkPolicyPath ?? path.join(applicationRoot, "config", "checks.json");
  const packagePath =
    selection.packagePolicyPath ?? path.join(applicationRoot, "config", "package-policy.json");
  const permissionsPath = path.join(applicationRoot, "config", "permissions.json");

  const [checks, packaging, permissions] = await Promise.all([
    loadTrustedJson(checksPath, CheckPolicySchema, "check policy"),
    loadTrustedJson(packagePath, PackagePolicySchema, "package policy"),
    loadTrustedJson(permissionsPath, PermissionPolicySchema, "permission policy"),
  ]);

  return {
    checks: checks.value,
    packaging: {
      include: packaging.value.include,
      exclude: packaging.value.exclude,
      maximumEntries: packaging.value.maximumEntries ?? 10_000,
      maximumArchiveBytes: packaging.value.maximumArchiveBytes ?? 1_073_741_824,
    },
    permissions: permissions.value,
    protectedWorkspacePaths: [
      checks.canonicalPath,
      packaging.canonicalPath,
      permissions.canonicalPath,
    ],
  };
}
