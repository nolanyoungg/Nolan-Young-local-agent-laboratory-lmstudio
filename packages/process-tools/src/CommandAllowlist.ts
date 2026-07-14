import { isAbsolute } from "node:path";
import { z } from "zod";
import { ProcessToolError } from "./errors.js";

const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const CommandIdSchema = z.string().regex(/^[a-z][a-z0-9:_-]{0,63}$/u);
const noNul = (value: string): boolean => !value.includes("\0");
const PathStringSchema = z.string().min(1).max(32_768).refine(noNul, {
  message: "NUL characters are not permitted.",
});
const ArgumentSchema = z.string().max(16_384).refine(noNul, {
  message: "NUL characters are not permitted.",
});
const EnvironmentValueSchema = z.string().max(32_768).refine(noNul, {
  message: "NUL characters are not permitted.",
});

export const TrustedCommandDefinitionSchema = z
  .object({
    id: CommandIdSchema,
    executable: PathStringSchema,
    args: z.array(ArgumentSchema).max(128).default([]),
    cwd: PathStringSchema,
    timeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
    environment: z.record(EnvironmentNameSchema, EnvironmentValueSchema).default({}),
    inheritEnvironment: z.array(EnvironmentNameSchema).max(32).default([]),
  })
  .strict();

export type TrustedCommandDefinitionInput = z.input<typeof TrustedCommandDefinitionSchema>;

export interface TrustedCommandDefinition {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly inheritEnvironment: readonly string[];
}

export const CommandSelectionSchema = z.object({ commandId: CommandIdSchema }).strict();

export interface CommandSelection {
  readonly commandId: string;
}

export class CommandAllowlist {
  readonly #definitions = new Map<string, TrustedCommandDefinition>();

  public constructor(definitions: readonly TrustedCommandDefinitionInput[]) {
    for (const input of definitions) {
      const parsed = TrustedCommandDefinitionSchema.safeParse(input);
      if (!parsed.success) {
        throw new ProcessToolError(
          "INVALID_COMMAND_DEFINITION",
          parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        );
      }
      if (!isAbsolute(parsed.data.executable) || !isAbsolute(parsed.data.cwd)) {
        throw new ProcessToolError(
          "INVALID_COMMAND_DEFINITION",
          `Command ${parsed.data.id} must use absolute executable and cwd paths.`,
        );
      }
      if (this.#definitions.has(parsed.data.id)) {
        throw new ProcessToolError(
          "DUPLICATE_COMMAND",
          `Command ID is duplicated: ${parsed.data.id}`,
        );
      }

      const definition: TrustedCommandDefinition = Object.freeze({
        id: parsed.data.id,
        executable: parsed.data.executable,
        args: Object.freeze([...parsed.data.args]),
        cwd: parsed.data.cwd,
        timeoutMs: parsed.data.timeoutMs,
        environment: Object.freeze({ ...parsed.data.environment }),
        inheritEnvironment: Object.freeze([...parsed.data.inheritEnvironment]),
      });
      this.#definitions.set(definition.id, definition);
    }
  }

  public resolve(selection: unknown): TrustedCommandDefinition {
    const parsed = CommandSelectionSchema.safeParse(selection);
    if (!parsed.success) {
      throw new ProcessToolError(
        "COMMAND_NOT_ALLOWED",
        "A process request may contain only a valid symbolic commandId.",
      );
    }
    const definition = this.#definitions.get(parsed.data.commandId);
    if (definition === undefined) {
      throw new ProcessToolError(
        "COMMAND_NOT_ALLOWED",
        `Command is not allowlisted: ${parsed.data.commandId}`,
      );
    }
    return definition;
  }

  public listCommandIds(): readonly string[] {
    return [...this.#definitions.keys()].sort((left, right) => left.localeCompare(right));
  }
}
