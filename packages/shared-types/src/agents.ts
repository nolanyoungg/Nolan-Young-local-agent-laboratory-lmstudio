import { z } from "zod";

import { IdentifierSchema } from "./json.js";
import { ToolNameSchema } from "./tools.js";

export const AgentIdentitySchema = z
  .object({
    id: IdentifierSchema,
    name: z.string().trim().min(1).max(256),
    description: z.string().trim().min(1).max(8_192),
  })
  .strict();

export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

export const AgentPermissionsSchema = z
  .object({
    allowedTools: z.array(ToolNameSchema).max(32).default([]),
    readGlobs: z.array(z.string().min(1).max(1_024)).max(256).default([]),
    writeGlobs: z.array(z.string().min(1).max(1_024)).max(256).default([]),
    deleteGlobs: z.array(z.string().min(1).max(1_024)).max(256).default([]),
    forbiddenGlobs: z.array(z.string().min(1).max(1_024)).max(256).default([]),
  })
  .strict();

export type AgentPermissions = z.infer<typeof AgentPermissionsSchema>;

export const AgentDefinitionSchema = AgentIdentitySchema.extend({
  systemPrompt: z.string().min(1).max(250_000),
  permissions: AgentPermissionsSchema,
  maxSteps: z.number().int().positive().max(1_000).default(20),
}).strict();

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const AgentRunStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "step_limit",
]);

export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;
