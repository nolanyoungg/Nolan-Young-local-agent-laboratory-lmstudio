import { ProcessToolError } from "./errors.js";
import type { TrustedCommandDefinition } from "./CommandAllowlist.js";

const SAFE_DEFAULT_NAMES = [
  "APPDATA",
  "CI",
  "COLORTERM",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "USERPROFILE",
  "WINDIR",
] as const;

const SECRET_NAME = /(AUTH|COOKIE|CREDENTIAL|KEY|PASS|SECRET|TOKEN)/iu;
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function createSanitizedEnvironment(
  definition: TrustedCommandDefinition,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of SAFE_DEFAULT_NAMES) {
    copyEnvironmentValue(source, environment, name);
  }
  // Windows commonly exposes Path rather than PATH.
  copyEnvironmentValue(source, environment, "Path");

  for (const name of definition.inheritEnvironment) {
    assertSafeName(name);
    copyEnvironmentValue(source, environment, name);
  }
  for (const [name, value] of Object.entries(definition.environment)) {
    assertSafeName(name);
    environment[name] = value;
  }
  return environment;
}

function assertSafeName(name: string): void {
  if (!VALID_NAME.test(name) || SECRET_NAME.test(name)) {
    throw new ProcessToolError(
      "INVALID_COMMAND_DEFINITION",
      `Environment variable is not permitted for child processes: ${name}`,
    );
  }
}

function copyEnvironmentValue(
  source: NodeJS.ProcessEnv,
  destination: NodeJS.ProcessEnv,
  name: string,
): void {
  const value = source[name];
  if (value !== undefined) {
    destination[name] = value;
  }
}
