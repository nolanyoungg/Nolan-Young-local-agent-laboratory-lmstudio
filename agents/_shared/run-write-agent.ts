import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { AgentRunner, ToolRegistry } from "@local-agent-lab/agent-runtime";
import {
  ApplyPatchInputSchema,
  CreateFileInputSchema,
  ListFilesInputSchema,
  ReadFileInputSchema,
  ReadFileMetadataInputSchema,
  RunValidationInputSchema,
  RunValidationTool,
  SearchTextInputSchema,
  ToolFactory,
  WriteFileInputSchema,
  type ValidationResult,
} from "@local-agent-lab/filesystem-tools";
import { createLMStudioModelClient } from "@local-agent-lab/local-model-client";
import { WorkspaceGuard, WorkspaceLock } from "@local-agent-lab/workspace-security";
import { JsonlTraceWriter, ReportWriter } from "@local-agent-lab/tracing";
import { assertAgentExecutionMode, loadAgent, loadSkill } from "./agent-library.js";
import { publishFinalArtifact } from "./final-artifact.js";

const root = resolve(import.meta.dirname, "..", "..");
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
const apply = args.includes("--apply");
const manifest = await loadAgent(root, agentId);
assertAgentExecutionMode(manifest, "write");
const requestedSkills = (option("--skill") ?? "").split(",").filter(Boolean);
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
const guard = await WorkspaceGuard.create(workspace, { writeGlobs: ["**", "**/*"] });
const lock = apply
  ? await WorkspaceLock.acquire({
      workspaceRoot: guard.root,
      trustedLockRoot: resolve(root, "reports", "workspace-locks"),
    })
  : undefined;

const expectedPartNames = [
  "content-home-hero.php",
  "content-home-trust.php",
  "content-home-introduction.php",
  "content-home-services.php",
  "content-home-feature.php",
  "content-home-process.php",
  "content-home-results.php",
  "content-home-testimonials.php",
  "content-home-cta.php",
] as const;
const finalSchema = z
  .object({
    status: z.enum(["PREVIEW", "READY", "READY_WITH_WARNINGS", "NOT_READY", "BLOCKED"]),
    summary: z.string().min(1),
    homepageTemplatePath: z.string().min(1),
    templatePartPaths: z.array(z.string().min(1)).length(9),
    integration: z.string().min(1),
    createdFiles: z.array(z.string()),
    changedFiles: z.array(z.string()),
    placeholders: z.array(z.string()),
    blockedChecks: z.array(z.string()),
    limitations: z.array(z.string()),
  })
  .strict();

try {
  const tools = ToolFactory.create(guard, { dryRun: !apply });
  const validation = new RunValidationTool({ workspaceGuard: guard, dryRun: !apply }, guard.root);
  const registry = new ToolRegistry();
  const inspected = new Set<string>();
  const themeSourcesRead = new Set<string>();
  const validationResults: ValidationResult[] = [];
  const isThemeSource = (path: string) =>
    /(?:\.(?:php|css|scss|sass|less|js|ts)|(?:^|\/)theme\.json)$/i.test(path);
  const normalize = (input: unknown): unknown => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
    const path = (input as Readonly<Record<string, unknown>>)["path"];
    if (typeof path !== "string" || !path.startsWith("/")) return input;
    return { ...input, path: path.replace(/^\/+/, "") || "." };
  };
  for (const [name, schema, execute] of [
    ["list_files", ListFilesInputSchema, tools.listFiles.execute.bind(tools.listFiles)],
    ["read_file", ReadFileInputSchema, tools.readFile.execute.bind(tools.readFile)],
    [
      "read_file_metadata",
      ReadFileMetadataInputSchema,
      tools.readFileMetadata.execute.bind(tools.readFileMetadata),
    ],
    ["search_text", SearchTextInputSchema, tools.searchText.execute.bind(tools.searchText)],
    ["create_file", CreateFileInputSchema, tools.createFile.execute.bind(tools.createFile)],
    ["write_file", WriteFileInputSchema, tools.writeFile.execute.bind(tools.writeFile)],
    ["apply_patch", ApplyPatchInputSchema, tools.applyPatch.execute.bind(tools.applyPatch)],
  ] as const) {
    registry.register({
      name,
      description:
        name === "create_file" || name === "write_file" || name === "apply_patch"
          ? `Guarded ${name}; writes are ${apply ? "enabled" : "preview-only"}.`
          : `Read-only ${name}`,
      mutating: name === "create_file" || name === "write_file" || name === "apply_patch",
      inputSchema: schema,
      execute: async (input) => {
        if (
          (name === "create_file" || name === "write_file" || name === "apply_patch") &&
          themeSourcesRead.size === 0
        )
          throw new Error(
            "Discovery required before proposing homepage mutations: use read_file on an existing PHP, stylesheet, script, or theme.json source file first.",
          );
        const result = await execute(normalize(input));
        if (
          (name === "read_file" || name === "read_file_metadata") &&
          typeof result === "object" &&
          result !== null &&
          "path" in result &&
          typeof result.path === "string"
        )
          inspected.add(result.path);
        if (
          name === "read_file" &&
          typeof result === "object" &&
          result !== null &&
          "path" in result &&
          typeof result.path === "string" &&
          isThemeSource(result.path)
        )
          themeSourcesRead.add(result.path);
        return result;
      },
    });
  }
  registry.register({
    name: "run_validation",
    description:
      "Run only PHP lint or an approved declared npm build/lint/test/typecheck/package script. npm validation requires --apply.",
    mutating: false,
    inputSchema: RunValidationInputSchema,
    execute: async (input) => {
      const result = await validation.execute(normalize(input));
      validationResults.push(result);
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
  if (!model) throw new Error("No tool/structured-output-capable local model is available.");
  const result = await new AgentRunner().run(
    {
      id: manifest.id,
      allowedTools: manifest.allowedTools,
      finalSchema,
      systemPrompt: `${manifest.instructions}\n\nLoaded skills:\n${skills.join("\n\n")}\n\n${apply ? "APPLY MODE: writes are enabled only inside the guarded workspace." : "PREVIEW MODE: every mutation is an in-memory proposal; do not claim files were written."} Inspect an existing file before changing it. Use create_file only for new files. Final createdFiles and changedFiles must exactly match the mutation journal.`,
    },
    {
      runId,
      model,
      task,
      temperature: 0.1,
      contextTokens: 32768,
      maxOutputTokens: 4096,
      maximumSteps: maxSteps,
      dryRun: !apply,
      tools: registry,
      trace: { record: (event) => trace.append(event) },
      validateComplete: (final) => {
        const { kind, ...candidate } = final;
        void kind;
        const report = finalSchema.parse(candidate);
        if (themeSourcesRead.size === 0)
          return "At least one existing theme source file must be read with read_file before completion.";
        const names = report.templatePartPaths.map((path) => path.split("/").at(-1)).sort();
        if (JSON.stringify(names) !== JSON.stringify([...expectedPartNames].sort()))
          return "templatePartPaths must contain exactly the nine required content-home filenames.";
        if (report.homepageTemplatePath.split("/").at(-1) !== "home-page.php")
          return "homepageTemplatePath must name home-page.php.";
        const mutations = registry.mutationJournal();
        const mutationPaths = new Set(
          mutations.flatMap((entry) => (entry.path ? [entry.path] : [])),
        );
        const reportedPaths = [...report.createdFiles, ...report.changedFiles].sort();
        if (new Set(reportedPaths).size !== reportedPaths.length)
          return "createdFiles and changedFiles may not contain duplicate paths.";
        const created = mutations
          .flatMap((entry) =>
            entry.path !== undefined && entry.beforeSha256 === null ? [entry.path] : [],
          )
          .sort();
        const changed = mutations
          .flatMap((entry) =>
            entry.path !== undefined && entry.beforeSha256 !== null ? [entry.path] : [],
          )
          .sort();
        if (
          JSON.stringify(report.createdFiles.slice().sort()) !== JSON.stringify(created) ||
          JSON.stringify(report.changedFiles.slice().sort()) !== JSON.stringify(changed) ||
          reportedPaths.some((path) => !mutationPaths.has(path))
        )
          return "createdFiles and changedFiles must exactly match categorized mutation journal paths.";
        if (
          !inspected.has(report.homepageTemplatePath) &&
          !mutationPaths.has(report.homepageTemplatePath)
        )
          return "homepageTemplatePath must be inspected or created/changed during this run.";
        if (
          report.templatePartPaths.some((path) => !inspected.has(path) && !mutationPaths.has(path))
        )
          return "Every template part must be inspected or created/changed during this run.";
        if (!apply && report.status !== "PREVIEW")
          return "Preview runs must return PREVIEW status.";
        return undefined;
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
          return {
            parsed: response.value,
            content: response.content,
            model: response.model,
            diagnostics: {
              serverModel: response.model,
              ...(response.promptTokens === undefined
                ? {}
                : { promptTokens: response.promptTokens }),
              ...(response.completionTokens === undefined
                ? {}
                : { completionTokens: response.completionTokens }),
              ...(response.stopReason === undefined ? {} : { finishReason: response.stopReason }),
              outputBytes: Buffer.byteLength(response.content, "utf8"),
            },
          };
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
    mode: apply ? "apply" : "preview",
    model,
    baseUrl: client.config.baseUrl,
    mutations: registry.mutationJournal(),
    validations: validationResults,
    toolCalls: result.toolCalls,
    ...(result.lastModelDiagnostics === undefined
      ? {}
      : { modelDiagnostics: result.lastModelDiagnostics }),
  };
  await writer.writeJson(resolve(runPath, "result.json"), payload);
  await writer.writeJson(resolve(runPath, "run-metadata.json"), {
    runId,
    agent: manifest.id,
    skills: skillIds,
    mode: apply ? "apply" : "preview",
    workspace: guard.root,
    model,
    baseUrl: client.config.baseUrl,
    ...(result.lastModelDiagnostics === undefined
      ? {}
      : { modelDiagnostics: result.lastModelDiagnostics }),
  });
  const reportPath = resolve(runPath, "report.md");
  await writeFile(
    reportPath,
    `# ${manifest.id}\n\n**Mode:** ${apply ? "apply" : "preview"}\n\n**Status:** ${finalReport.status}\n\n${finalReport.summary}\n\n## Homepage integration\n\n${finalReport.integration}\n\n## Homepage files\n\n- Template: ${finalReport.homepageTemplatePath}\n${finalReport.templatePartPaths.map((path) => `- Template part: ${path}`).join("\n")}\n\n## Mutations\n\n${payload.mutations.map((item) => `- ${item.path} (${item.dryRun ? "preview" : "written"})`).join("\n") || "None."}\n\n## Validation\n\n${validationResults.map((item) => `- ${item.status}: ${item.command}`).join("\n") || "None."}\n\n## Blocked checks\n\n${finalReport.blockedChecks.map((item) => `- ${item}`).join("\n") || "None."}\n`,
    "utf8",
  );
  await publishFinalArtifact({ root, producerId: manifest.id, reportPath });
  await trace.close();
  console.log(JSON.stringify({ runPath, ...payload }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown model protocol failure.";
  const diagnostics =
    typeof error === "object" && error !== null && "details" in error
      ? (error as { readonly details: unknown }).details
      : undefined;
  const payload = {
    status: "MODEL_PROTOCOL_ERROR",
    runId,
    agent: manifest.id,
    skills: skillIds,
    mode: apply ? "apply" : "preview",
    model: option("--model") ?? "unresolved",
    baseUrl: option("--lmstudio-url") ?? "configured endpoint",
    message,
    limitation:
      "No repair prompt was sent. Apply-mode writes completed before the failure remain recorded in trace.jsonl.",
    ...(diagnostics === undefined ? {} : { modelDiagnostics: diagnostics }),
  };
  await writer.writeJson(resolve(runPath, "result.json"), payload);
  const reportPath = resolve(runPath, "report.md");
  await writer.writeText(
    reportPath,
    `# ${manifest.id}\n\n**Status:** MODEL_PROTOCOL_ERROR\n\n${message}\n\nNo repair prompt was sent. See trace.jsonl for redacted completion metadata and any completed mutations.\n`,
  );
  await publishFinalArtifact({ root, producerId: manifest.id, reportPath });
  await trace.close();
  console.error(JSON.stringify({ runPath, ...payload }, null, 2));
  process.exitCode = 2;
} finally {
  await lock?.release();
}
