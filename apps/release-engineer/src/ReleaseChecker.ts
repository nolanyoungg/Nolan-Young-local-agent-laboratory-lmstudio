import { matchesAnyGlob } from "./glob.js";
import type { CheckPolicy, PackageMetadata, ReleaseCheckResult, ReleaseFinding } from "./types.js";
import type { WorkspaceSnapshot } from "./WorkspaceSnapshot.js";

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function finding(code: string, message: string, path?: string): ReleaseFinding {
  return {
    code,
    severity: "error",
    message,
    ...(path === undefined ? {} : { path }),
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class ReleaseChecker {
  public constructor(private readonly policy: CheckPolicy) {}

  public async check(snapshot: WorkspaceSnapshot): Promise<ReleaseCheckResult> {
    const findings: ReleaseFinding[] = [];
    const entries = await snapshot.entries();

    for (const entry of entries) {
      if (entry.kind === "symlink") {
        findings.push(
          finding(
            "SYMLINK_FORBIDDEN",
            "Release workspaces may not contain symlinks or junctions.",
            entry.path,
          ),
        );
      } else if (entry.kind === "other") {
        findings.push(
          finding(
            "NON_REGULAR_ENTRY",
            "Release workspaces may contain only directories and regular files.",
            entry.path,
          ),
        );
      }
      if (matchesAnyGlob(entry.path, this.policy.forbiddenGlobs)) {
        findings.push(
          finding("FORBIDDEN_WORKSPACE_ENTRY", "A forbidden release entry is present.", entry.path),
        );
      }
    }

    for (const requiredFile of this.policy.requiredFiles) {
      const entry = await snapshot.entry(requiredFile);
      if (entry === undefined || entry.kind !== "file") {
        findings.push(
          finding(
            "REQUIRED_FILE_MISSING",
            `Required release file is missing: ${requiredFile}`,
            requiredFile,
          ),
        );
      }
    }

    let metadata: PackageMetadata | undefined;
    const packageEntry = await snapshot.entry("package.json");
    if (packageEntry !== undefined && packageEntry.kind === "file") {
      let packageObject: Record<string, unknown> | undefined;
      try {
        const raw = (await snapshot.readText("package.json")).replace(/^\uFEFF/u, "");
        packageObject = objectValue(JSON.parse(raw) as unknown);
        if (packageObject === undefined) {
          findings.push(
            finding(
              "PACKAGE_JSON_INVALID",
              "package.json must contain a JSON object.",
              "package.json",
            ),
          );
        }
      } catch {
        findings.push(
          finding(
            "PACKAGE_JSON_INVALID",
            "package.json is not valid, bounded UTF-8 JSON.",
            "package.json",
          ),
        );
      }

      if (packageObject !== undefined) {
        for (const field of this.policy.requiredPackageFields) {
          const value = packageObject[field];
          if (typeof value !== "string" || value.trim().length === 0) {
            findings.push(
              finding(
                "PACKAGE_FIELD_MISSING",
                `package.json requires a non-empty ${field} field.`,
                "package.json",
              ),
            );
          }
        }
        const name = packageObject["name"];
        const version = packageObject["version"];
        if (typeof name === "string" && !PACKAGE_NAME.test(name)) {
          findings.push(
            finding(
              "PACKAGE_NAME_INVALID",
              "package.json name is not a valid portable npm package name.",
              "package.json",
            ),
          );
        }
        if (typeof version === "string" && !SEMVER.test(version)) {
          findings.push(
            finding(
              "PACKAGE_VERSION_INVALID",
              "package.json version must be valid semantic version text.",
              "package.json",
            ),
          );
        }
        if (
          typeof name === "string" &&
          PACKAGE_NAME.test(name) &&
          typeof version === "string" &&
          SEMVER.test(version)
        ) {
          const description = packageObject["description"];
          metadata = {
            name,
            version,
            ...(typeof description === "string" && description.trim().length > 0
              ? { description: description.trim().slice(0, 1_024) }
              : {}),
          };
        }
      }
    }

    findings.sort((left, right) =>
      `${left.path ?? ""}:${left.code}`.localeCompare(`${right.path ?? ""}:${right.code}`),
    );
    return {
      passed: findings.every((item) => item.severity !== "error"),
      findings,
      ...(metadata === undefined ? {} : { metadata }),
      inspectedFiles: entries.filter((entry) => entry.kind === "file").length,
    };
  }
}
