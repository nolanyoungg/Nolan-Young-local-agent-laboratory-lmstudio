import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotEnv } from "dotenv";
import {
  CommandAllowlist,
  createNpmCommandDefinition,
  type TrustedCommandDefinitionInput,
} from "@local-agent-lab/process-tools";
import { z } from "zod";

import { BuildAssistantError } from "./errors.js";
import { WatcherPolicySchema, type WatcherPolicy } from "./types.js";

const MAX_CONFIGURATION_BYTES = 262_144;

const EnvironmentNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  .refine((name) => !/(AUTH|COOKIE|CREDENTIAL|KEY|PASS|SECRET|TOKEN)/iu.test(name), {
    message: "secret-bearing environment names are forbidden",
  });

const CommandEntrySchema = z
  .object({
    kind: z.enum(["node", "npm"]),
    args: z.array(z.string().max(16_384)).max(128),
    timeoutMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
    environment: z.record(EnvironmentNameSchema, z.string().max(32_768)).default({}),
    inheritEnvironment: z.array(EnvironmentNameSchema).max(32).default([]),
    watcher: WatcherPolicySchema.optional(),
  })
  .strict();

const CommandConfigurationSchema = z
  .object({
    commands: z.record(z.string().regex(/^[a-z][a-z0-9:_-]{0,63}$/u), CommandEntrySchema),
  })
  .strict();

const PermissionConfigurationSchema = z
  .object({
    diagnostician: z.array(z.string()).max(32),
    repairer: z.array(z.string()).max(32),
    reviewer: z.array(z.string()).max(32),
  })
  .strict();

const ROLE_CAPABILITIES = {
  diagnostician: new Set([
    "list_files",
    "read_file",
    "read_file_metadata",
    "search_text",
    "process_status",
    "process_logs",
  ]),
  repairer: new Set([
    "list_files",
    "read_file",
    "read_file_metadata",
    "search_text",
    "create_file",
    "write_file",
    "apply_patch",
    "process_status",
    "process_logs",
  ]),
  reviewer: new Set([
    "list_files",
    "read_file",
    "read_file_metadata",
    "search_text",
    "process_status",
    "process_logs",
  ]),
} as const;

export interface ApplicationLocations {
  readonly applicationRoot: string;
  readonly laboratoryRoot: string;
}

export interface RolePermissions {
  readonly diagnostician: readonly string[];
  readonly repairer: readonly string[];
  readonly reviewer: readonly string[];
}

export interface LoadedCommandPolicy {
  readonly allowlist: CommandAllowlist;
  readonly canonicalConfigurationPath: string;
  readonly watcherByCommand: ReadonlyMap<string, WatcherPolicy>;
}

async function findApplicationRoot(): Promise<string> {
  let candidate = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const manifest = JSON.parse(
        await readFile(path.join(candidate, "package.json"), "utf8"),
      ) as unknown;
      if (
        typeof manifest === "object" &&
        manifest !== null &&
        !Array.isArray(manifest) &&
        (manifest as Record<string, unknown>)["name"] === "@local-agent-lab/build-assistant"
      ) {
        return await realpath(candidate);
      }
    } catch {
      // Only laboratory-owned ancestor manifests are inspected.
    }
    candidate = path.dirname(candidate);
  }
  throw new BuildAssistantError(
    "APPLICATION_ROOT_NOT_FOUND",
    "The Build Assistant application root could not be located.",
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

async function loadRegularJson(
  pathname: string,
  label: string,
): Promise<{
  readonly canonicalPath: string;
  readonly value: unknown;
}> {
  const absolutePath = path.resolve(pathname);
  let canonicalPath: string;
  try {
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("not a regular file");
    }
    if (metadata.size > MAX_CONFIGURATION_BYTES) {
      throw new BuildAssistantError(
        "CONFIGURATION_TOO_LARGE",
        `${label} exceeds ${MAX_CONFIGURATION_BYTES} bytes.`,
        "configuration",
      );
    }
    canonicalPath = await realpath(absolutePath);
  } catch (error) {
    if (error instanceof BuildAssistantError) throw error;
    throw new BuildAssistantError(
      "CONFIGURATION_UNREADABLE",
      `${label} must be a readable regular, non-symlink file.`,
      "configuration",
      { cause: error },
    );
  }

  try {
    return {
      canonicalPath,
      value: JSON.parse(await readFile(canonicalPath, "utf8")) as unknown,
    };
  } catch (error) {
    throw new BuildAssistantError(
      "CONFIGURATION_INVALID_JSON",
      `${label} is not valid JSON.`,
      "configuration",
      { cause: error },
    );
  }
}

async function resolveNpmExecPath(): Promise<string | undefined> {
  const candidates = [
    process.env["npm_execpath"],
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(
      path.dirname(process.execPath),
      "..",
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || !path.isAbsolute(candidate)) continue;
    try {
      const canonical = await realpath(candidate);
      const metadata = await lstat(canonical);
      if (metadata.isFile() && path.basename(canonical).toLowerCase() === "npm-cli.js") {
        return canonical;
      }
    } catch {
      // Continue through fixed Node/npm installation candidates.
    }
  }
  return undefined;
}

export async function loadCommandPolicy(
  options: Readonly<{
    applicationRoot: string;
    workspaceRoot: string;
    selectedPath?: string;
  }>,
): Promise<LoadedCommandPolicy> {
  const selectedPath =
    options.selectedPath ?? path.join(options.applicationRoot, "config", "commands.example.json");
  const loaded = await loadRegularJson(selectedPath, "command configuration");
  const parsed = CommandConfigurationSchema.safeParse(loaded.value);
  if (!parsed.success || Object.keys(parsed.data?.commands ?? {}).length === 0) {
    const issues = parsed.success
      ? "at least one command is required"
      : parsed.error.issues
          .slice(0, 8)
          .map((issue) => `${issue.path.join(".") || "root"}: ${issue.code}`)
          .join("; ");
    throw new BuildAssistantError(
      "COMMAND_CONFIGURATION_INVALID",
      `Command configuration failed validation (${issues}).`,
      "configuration",
    );
  }

  const npmExecPath = await resolveNpmExecPath();
  const definitions: TrustedCommandDefinitionInput[] = [];
  const watcherByCommand = new Map<string, WatcherPolicy>();
  for (const [id, entry] of Object.entries(parsed.data.commands)) {
    const common = {
      id,
      cwd: options.workspaceRoot,
      args: entry.args,
      timeoutMs: entry.timeoutMs,
      environment: entry.environment,
      inheritEnvironment: entry.inheritEnvironment,
    } as const;
    if (entry.kind === "npm") {
      try {
        definitions.push(await createNpmCommandDefinition(common, npmExecPath));
      } catch (error) {
        throw new BuildAssistantError(
          "NPM_RUNTIME_UNAVAILABLE",
          "A validated npm-cli.js could not be found for the trusted npm command map.",
          "configuration",
          { cause: error },
        );
      }
    } else {
      definitions.push({
        ...common,
        executable: process.execPath,
      });
    }
    if (entry.watcher !== undefined) watcherByCommand.set(id, entry.watcher);
  }

  return {
    allowlist: new CommandAllowlist(definitions),
    canonicalConfigurationPath: loaded.canonicalPath,
    watcherByCommand,
  };
}

export async function loadRolePermissions(applicationRoot: string): Promise<RolePermissions> {
  const loaded = await loadRegularJson(
    path.join(applicationRoot, "config", "permissions.json"),
    "role permission configuration",
  );
  const parsed = PermissionConfigurationSchema.safeParse(loaded.value);
  if (!parsed.success) {
    throw new BuildAssistantError(
      "PERMISSIONS_INVALID",
      "The laboratory-owned role permission configuration is invalid.",
      "configuration",
    );
  }
  for (const role of ["diagnostician", "repairer", "reviewer"] as const) {
    const ceiling = ROLE_CAPABILITIES[role];
    for (const tool of parsed.data[role]) {
      if (!ceiling.has(tool)) {
        throw new BuildAssistantError(
          "PERMISSION_ESCALATION",
          `Role ${role} requests an unauthorized tool: ${tool}.`,
          "configuration",
        );
      }
    }
  }
  return {
    diagnostician: Object.freeze([...parsed.data.diagnostician]),
    repairer: Object.freeze([...parsed.data.repairer]),
    reviewer: Object.freeze([...parsed.data.reviewer]),
  };
}

export async function loadSystemPrompt(
  applicationRoot: string,
  role: "diagnostician" | "repairer" | "reviewer",
): Promise<string> {
  const promptPath = path.join(applicationRoot, "prompts", `${role}.system.md`);
  const loaded = await lstat(promptPath);
  if (!loaded.isFile() || loaded.isSymbolicLink() || loaded.size > 250_000) {
    throw new BuildAssistantError(
      "PROMPT_INVALID",
      `The laboratory-owned ${role} prompt is invalid.`,
      "configuration",
    );
  }
  return await readFile(promptPath, "utf8");
}
