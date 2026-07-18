import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AgentRunner, ToolRegistry } from "@local-agent-lab/agent-runtime";
import {
  ToolFactory,
  ListFilesInputSchema,
  ReadFileInputSchema,
  ReadFileMetadataInputSchema,
  SearchTextInputSchema,
} from "@local-agent-lab/filesystem-tools";
import { createLMStudioModelClient } from "@local-agent-lab/local-model-client";
import { WorkspaceGuard } from "@local-agent-lab/workspace-security";
import { JsonlTraceWriter, ReportWriter } from "@local-agent-lab/tracing";
import { loadAgent, loadSkill } from "./agent-library.js";
import { verifyWordPressTheme } from "./wordpress-theme-verifier.js";
import {
  markdownThemeFileReview,
  reviewWordPressThemeFiles,
} from "./wordpress-theme-file-reviewer.js";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const required = (name: string) => {
  const value = option(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const agentId = required("--agent");
const workspace = required("--workspace");
const task = required("--task");
const requestedSkills = (option("--skill") ?? "").split(",").filter(Boolean);
const manifest = await loadAgent(root, agentId);
const skillIds = [...new Set([...manifest.defaultSkills, ...requestedSkills])];
const skills = await Promise.all(skillIds.map((id) => loadSkill(root, id)));
const maxSteps = Number(option("--max-steps") ?? manifest.maxSteps);
if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > manifest.maxSteps)
  throw new Error(`--max-steps must be 1-${manifest.maxSteps}`);
const reportDirectory = resolve(
  option("--report-directory") ?? resolve(root, "reports", "agent-runs"),
);
const runId = randomUUID();
const runPath = resolve(
  reportDirectory,
  `${new Date().toISOString().replace(/[-:.]/g, "")}-${agentId}-${runId}`,
);
await mkdir(runPath, { recursive: true });
const trace = new JsonlTraceWriter(resolve(runPath, "trace.jsonl"));
const writer = new ReportWriter();
const guard = await WorkspaceGuard.create(workspace);
const normalizeWorkspaceRelativePath = (input: unknown): unknown => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const path = (input as Readonly<Record<string, unknown>>)["path"];
  if (typeof path !== "string" || !path.startsWith("/")) return input;
  const relativePath = path.replace(/^\/+/, "") || ".";
  return { ...input, path: relativePath };
};
if (manifest.id === "wordpress-theme-file-reviewer-agent") {
  const review = await reviewWordPressThemeFiles(guard.root);
  const payload = { ...review, runId, agent: manifest.id, skills: skillIds };
  await writer.writeJson(resolve(runPath, "result.json"), payload);
  await writer.writeJson(resolve(runPath, "run-metadata.json"), {
    runId,
    agent: manifest.id,
    skills: skillIds,
    workspace: guard.root,
    provider: "deterministic local WordPress theme file reviewer",
  });
  await writeFile(resolve(runPath, "report.md"), markdownThemeFileReview(review), "utf8");
  await trace.close();
  console.log(JSON.stringify({ runPath, ...payload }, null, 2));
  process.exitCode = review.findings.some((finding) => finding.status === "FAIL")
    ? 1
    : review.findings.some((finding) => finding.status === "BLOCKED")
      ? 2
      : 0;
} else if (manifest.id === "wordpress-theme-verification-agent") {
  const verification = await verifyWordPressTheme(guard.root);
  const suppliedUrl = option("--lmstudio-url");
  const suppliedModel = option("--model");
  const client = createLMStudioModelClient({
    config: {
      ...(suppliedUrl === undefined ? {} : { baseUrl: suppliedUrl }),
      ...(suppliedModel === undefined ? {} : { requestedModel: suppliedModel }),
    },
  });
  const models = await client.listModels();
  const model = suppliedModel ?? models[0]?.logicalKey;
  if (!model)
    throw new Error(
      "No models are currently available from LM Studio. Load a structured-output-capable model, then retry.",
    );
  const assessmentSchema = z
    .object({
      verdict: z.enum(["consistent", "inconsistent", "insufficient-evidence"]),
      failingCheckIds: z.array(z.string().min(1).max(160)).max(10),
    })
    .strict();
  const assessmentEvidence = {
    themePath: verification.themePath,
    themeType: verification.themeType,
    status: verification.status,
    summary: verification.summary,
    checks: verification.checks.slice(0, 100),
    phpLint: verification.phpLint.slice(0, 100).map(({ path, status }) => ({ path, status })),
    truncated: verification.checks.length > 100 || verification.phpLint.length > 100,
  };
  const assessment = await client.complete(
    {
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a WordPress theme verification reviewer. Use only the deterministic verification evidence supplied by the user. Return verdict consistent when it supports the deterministic status, inconsistent when a supplied failing or blocked check needs attention, or insufficient-evidence when the supplied evidence is incomplete. Include only supplied failing or blocked check IDs in failingCheckIds. Do not inspect files, run commands, or add prose.",
        },
        {
          role: "user",
          content: `Task: ${task}\n\nDeterministic verification evidence:\n${JSON.stringify(assessmentEvidence)}`,
        },
      ],
      temperature: 0.1,
      maxTokens: 128,
      structuredOutput: true,
    },
    assessmentSchema,
  );
  const invalidFinding = assessment.value.failingCheckIds.find(
    (checkId) =>
      !verification.checks.some(
        (check) => check.id === checkId && (check.status === "FAIL" || check.status === "BLOCKED"),
      ),
  );
  if (invalidFinding)
    throw new Error(
      `Model assessment cited ${JSON.stringify(invalidFinding)}, which is not a failing or blocked deterministic check.`,
    );
  const payload = {
    ...verification,
    runId,
    agent: manifest.id,
    skills: skillIds,
    model: assessment.model,
    baseUrl: client.config.baseUrl,
    provider: "LM Studio with deterministic WordPress verifier",
    modelAssessment: assessment.value,
  };
  await writer.writeJson(resolve(runPath, "result.json"), payload);
  await writer.writeJson(resolve(runPath, "run-metadata.json"), {
    runId,
    agent: manifest.id,
    skills: skillIds,
    workspace: guard.root,
    model: assessment.model,
    baseUrl: client.config.baseUrl,
    provider: "LM Studio with deterministic WordPress verifier",
  });
  await writeFile(
    resolve(runPath, "report.md"),
    `# ${manifest.id}\n\n**Theme path:** ${verification.themePath}\n\n**Detected theme type:** ${verification.themeType}\n\n**Overall status:** ${verification.status}\n\n## Checks performed\n\n${verification.checks.map((item) => `- **${item.status}** (${item.requirement}) ${item.id}: ${item.detail}${item.remediation ? ` Remediation: ${item.remediation}` : ""}`).join("\n")}\n\n## PHP lint results\n\n${verification.phpLint.map((item) => `- **${item.status}** ${item.path}: ${item.output}`).join("\n") || "No PHP files were found."}\n\n## Summary\n\n${verification.summary}\n\n## Model confirmation\n\n- **Verdict:** ${assessment.value.verdict}\n- **Failing or blocked checks acknowledged by the model:** ${assessment.value.failingCheckIds.join(", ") || "None"}\n`,
    "utf8",
  );
  await trace.close();
  console.log(JSON.stringify({ runPath, ...payload }, null, 2));
  process.exitCode = verification.status === "PASS" ? 0 : verification.status === "BLOCKED" ? 2 : 1;
} else {
  const tools = ToolFactory.create(guard);
  const registry = new ToolRegistry();
  const inspected = new Set<string>();
  for (const [name, schema, execute] of [
    ["list_files", ListFilesInputSchema, tools.listFiles.execute.bind(tools.listFiles)],
    ["read_file", ReadFileInputSchema, tools.readFile.execute.bind(tools.readFile)],
    [
      "read_file_metadata",
      ReadFileMetadataInputSchema,
      tools.readFileMetadata.execute.bind(tools.readFileMetadata),
    ],
    ["search_text", SearchTextInputSchema, tools.searchText.execute.bind(tools.searchText)],
  ] as const)
    registry.register({
      name,
      description: `Read-only ${name}`,
      mutating: false,
      inputSchema: schema,
      execute: async (input) => {
        const result = await execute(normalizeWorkspaceRelativePath(input));
        if (
          (name === "read_file" || name === "read_file_metadata") &&
          typeof result === "object" &&
          result &&
          "path" in result &&
          typeof result.path === "string"
        )
          inspected.add(result.path);
        return result;
      },
    });
  const suppliedUrl = option("--lmstudio-url");
  const suppliedModel = option("--model");
  const client = createLMStudioModelClient({
    config: {
      ...(suppliedUrl === undefined ? {} : { baseUrl: suppliedUrl }),
      ...(suppliedModel === undefined ? {} : { requestedModel: suppliedModel }),
    },
  });
  const models = await client.listModels();
  const model = suppliedModel ?? models[0]?.logicalKey;
  if (!model)
    throw new Error(
      "No models are currently available from LM Studio. Load a tool/structured-output-capable model, then retry.",
    );
  const finalSchema = z
    .object({
      summary: z.string().min(1),
      scopeReviewed: z.array(z.string()).min(1),
      findings: z.array(
        z
          .object({
            severity: z.enum(["low", "medium", "high", "critical"]),
            path: z.string(),
            impact: z.string(),
            recommendation: z.string(),
            evidence: z.string(),
          })
          .strict(),
      ),
      limitations: z.array(z.string()),
    })
    .strict();
  const validateCompletion = (final: z.infer<typeof finalSchema>): string | undefined => {
    if (inspected.size === 0) return "Direct file evidence is required before completion.";
    if (final.scopeReviewed.some((path) => !inspected.has(path)))
      return "scopeReviewed may only contain paths successfully inspected through read_file or read_file_metadata.";
    if (final.findings.some((finding) => !inspected.has(finding.path)))
      return "Every finding path must be a successfully inspected file.";
    return undefined;
  };
  const result = await new AgentRunner().run(
    {
      id: manifest.id,
      allowedTools: manifest.allowedTools,
      finalSchema,
      systemPrompt: `${manifest.instructions}\n\nLoaded skills:\n${skills.join("\n\n")}\n\nYou must inspect direct source evidence before completing. scopeReviewed and every finding path must contain only successful inspected paths.`,
    },
    {
      runId,
      task,
      model,
      temperature: 0.1,
      contextTokens: 32768,
      maxOutputTokens: 4096,
      maximumSteps: maxSteps,
      dryRun: true,
      tools: registry,
      trace: { record: (event) => trace.append(event) },
      validateComplete: (final) => {
        const { kind, ...report } = final;
        void kind;
        return validateCompletion(finalSchema.parse(report));
      },
      modelClient: {
        complete: async (request, schema) => {
          const response = await client.complete(
            {
              model: request.model,
              messages: [...request.messages],
              temperature: request.temperature,
              maxTokens: request.maxOutputTokens,
              structuredOutput: true,
            },
            schema,
          );
          return { parsed: response.value, content: response.content, model: response.model };
        },
      },
    },
  );
  const { kind, ...finalReport } = result.final;
  void kind;
  const payload = {
    ...finalReport,
    runId,
    agent: manifest.id,
    skills: skillIds,
    model,
    baseUrl: client.config.baseUrl,
    toolCalls: result.toolCalls,
    scopeReviewed: result.final.scopeReviewed,
  };
  await writer.writeJson(resolve(runPath, "result.json"), payload);
  await writer.writeJson(resolve(runPath, "run-metadata.json"), {
    runId,
    agent: manifest.id,
    skills: skillIds,
    model,
    baseUrl: client.config.baseUrl,
    workspace: guard.root,
    provider: "LM Studio",
  });
  await writeFile(
    resolve(runPath, "report.md"),
    `# ${manifest.id}\n\n${result.final.summary}\n\n## Findings\n\n${result.final.findings.map((finding) => `- **${finding.severity}** ${finding.path}: ${finding.impact} Recommendation: ${finding.recommendation}`).join("\n") || "No findings."}\n\n## Limitations\n\n${result.final.limitations.map((value) => `- ${value}`).join("\n")}`,
    "utf8",
  );
  await trace.close();
  console.log(JSON.stringify({ runPath, ...payload }, null, 2));
}
