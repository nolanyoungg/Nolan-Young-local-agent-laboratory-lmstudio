import { z } from "zod";

import { LMStudioConnectionConfigSchema } from "./lmStudio.js";
import { ModelProviderSchema } from "./models.js";
import { WorkflowModeSchema } from "./workflows.js";

export const DEFAULT_MAX_AGENT_STEPS = 20;
export const DEFAULT_MAX_REPAIR_PASSES = 3;
export const DEFAULT_REPORTS_DIRECTORY = "reports/runs";

export const ConfigurationSourceSchema = z.enum(["cli", "environment", "application", "default"]);

export type ConfigurationSource = z.infer<typeof ConfigurationSourceSchema>;

export const CONFIGURATION_PRECEDENCE = [
  "cli",
  "environment",
  "application",
  "default",
] as const satisfies readonly ConfigurationSource[];

export const ApplicationConfigSchema = z
  .object({
    modelProvider: ModelProviderSchema.default("lmstudio"),
    lmStudio: LMStudioConnectionConfigSchema.default({}),
    workspace: z.string().min(1).max(32_768),
    task: z.string().min(1).max(100_000),
    mode: WorkflowModeSchema.default("dry-run"),
    maxAgentSteps: z.number().int().positive().max(1_000).default(20),
    maxRepairPasses: z.number().int().nonnegative().max(100).default(3),
    reportsDirectory: z.string().min(1).max(32_768).default("reports/runs"),
    verbose: z.boolean().default(false),
  })
  .strict();

export type ApplicationConfig = z.infer<typeof ApplicationConfigSchema>;
