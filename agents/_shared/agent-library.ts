import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export interface AgentManifest {
  executionMode: "read-only" | "write";
  id: string;
  defaultSkills: string[];
  allowedTools: string[];
  maxSteps: number;
  instructions: string;
}

export function assertAgentExecutionMode(
  manifest: AgentManifest,
  expected: AgentManifest["executionMode"],
): void {
  if (manifest.executionMode !== expected)
    throw new Error(
      expected === "read-only"
        ? "Write-capable agents must run through their matching agent command; add --apply to make real writes."
        : "Read-only agents must run through their matching agent command.",
    );
}

function field(text: string, name: string): string {
  const value = new RegExp(`^${name}:\\s*(.+)$`, "mu").exec(text)?.[1]?.trim();
  if (!value) throw new Error(`Missing ${name} in agent definition.`);
  return value;
}

function optionalField(text: string, name: string): string | undefined {
  return new RegExp(`^${name}:\\s*(.+)$`, "mu").exec(text)?.[1]?.trim();
}

export async function loadAgent(root: string, id: string): Promise<AgentManifest> {
  const instructions = await readFile(resolve(root, "agents", id, "AGENT.md"), "utf8");
  const allowedTools = field(instructions, "allowedTools")
    .split(",")
    .map((value) => value.trim());
  const executionMode = optionalField(instructions, "executionMode") ?? "read-only";
  if (executionMode !== "read-only" && executionMode !== "write")
    throw new Error("executionMode must be read-only or write.");
  const allowedByMode =
    executionMode === "read-only"
      ? ["list_files", "read_file", "read_file_metadata", "search_text"]
      : [
          "list_files",
          "read_file",
          "read_file_metadata",
          "search_text",
          "create_file",
          "write_file",
          "apply_patch",
          "run_validation",
        ];
  if (allowedTools.some((tool) => !allowedByMode.includes(tool)))
    throw new Error(`Agent tools are incompatible with ${executionMode} mode.`);
  return {
    executionMode,
    id: field(instructions, "id"),
    defaultSkills: field(instructions, "defaultSkills")
      .split(",")
      .map((value) => value.trim()),
    allowedTools,
    maxSteps: Number(field(instructions, "maxSteps")),
    instructions,
  };
}

export async function loadSkill(root: string, id: string): Promise<string> {
  return readFile(resolve(root, "skills", id, "SKILL.md"), "utf8");
}

export async function listAgents(root: string): Promise<string[]> {
  const entries = await readdir(resolve(root, "agents"), { withFileTypes: true });
  const names = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          await readFile(resolve(root, "agents", entry.name, "AGENT.md"), "utf8");
          return entry.name;
        } catch {
          return undefined;
        }
      }),
  );
  return names.filter((name): name is string => name !== undefined).sort();
}
