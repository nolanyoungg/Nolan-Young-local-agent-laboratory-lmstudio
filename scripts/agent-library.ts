import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export interface AgentManifest {
  id: string;
  defaultSkills: string[];
  allowedTools: string[];
  maxSteps: number;
  instructions: string;
}

function field(text: string, name: string): string {
  const value = new RegExp(`^${name}:\\s*(.+)$`, "mu").exec(text)?.[1]?.trim();
  if (!value) throw new Error(`Missing ${name} in agent definition.`);
  return value;
}

export async function loadAgent(root: string, id: string): Promise<AgentManifest> {
  const instructions = await readFile(resolve(root, "agents", id, "AGENT.md"), "utf8");
  const allowedTools = field(instructions, "allowedTools")
    .split(",")
    .map((value) => value.trim());
  if (
    allowedTools.some(
      (tool) => !["list_files", "read_file", "read_file_metadata", "search_text"].includes(tool),
    )
  )
    throw new Error("Agents may only use the four read-only workspace tools.");
  return {
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
