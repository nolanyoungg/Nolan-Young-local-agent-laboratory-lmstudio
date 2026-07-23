import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { AgentRunner, ToolRegistry } from "@local-agent-lab/agent-runtime";
import { ListFilesInputSchema, ReadFileInputSchema, ReadFileMetadataInputSchema, SearchTextInputSchema, ToolFactory } from "@local-agent-lab/filesystem-tools";
import { createLMStudioModelClient } from "@local-agent-lab/local-model-client";
import { WorkspaceGuard } from "@local-agent-lab/workspace-security";
import { JsonlTraceWriter, ReportWriter } from "@local-agent-lab/tracing";

const root = resolve(import.meta.dirname, "..", "..");
export const reviewStages = [
  ["inventory", "Repository inventory", 32, "Inventory the whole repository: languages, entry points, architecture, generated/vendor boundaries, and coverage."],
  ["data-flow", "Core workflow and data flow", 44, "Trace inputs, state transitions, outputs, integrations, and error propagation."],
  ["defects", "Defect review", 48, "Find evidence-supported logic, validation, authorization, async/resource, edge-case, and unsafe-assumption defects."],
  ["operational-quality", "Operational quality", 40, "Review tests, CI, scripts, dependencies, configuration, documentation drift, and maintainability risks."],
  ["evidence-validation", "Evidence validation and synthesis", 36, "Discard speculation and keep only directly supported findings with honest limitations."],
] as const;
type StageId = (typeof reviewStages)[number][0];
type Finding = { severity: "low" | "medium" | "high" | "critical"; title: string; path: string; evidence: string; impact: string; recommendation: string; confidence: "low" | "medium" | "high"; limitations: string[]; fingerprint: string };
const candidateSchema = z.object({ severity: z.enum(["low", "medium", "high", "critical"]), title: z.string().min(1).max(180), path: z.string().min(1), evidence: z.string().min(1), impact: z.string().min(1), recommendation: z.string().min(1), confidence: z.enum(["low", "medium", "high"]), limitations: z.array(z.string()) }).strict();
const stageSchema = z.object({ summary: z.string().min(1), scopeReviewed: z.array(z.string().min(1)).min(1), findings: z.array(candidateSchema), limitations: z.array(z.string()) }).strict();
export type StagedReview = { schemaVersion: 1; runId: string; agent: "github-repo-review"; workspace: string; model: string; baseUrl: string; completedStages: StageId[]; stages: { id: StageId; title: string; summary: string; scopeReviewed: string[]; limitations: string[] }[]; findings: Finding[]; limitations: string[] };
export const fingerprintForFinding = (finding: Omit<Finding, "fingerprint">): string => createHash("sha256").update(`${finding.path}\n${finding.title.trim().toLowerCase()}\n${finding.evidence.trim()}`).digest("hex").slice(0, 24);
export const markdownStagedReview = (review: StagedReview): string => `# GitHub Repository Review\n\n**Workspace:** ${review.workspace}\n\n**Completed stages:** ${review.completedStages.join(", ")}\n\n## Stage summaries\n\n${review.stages.map((stage) => `### ${stage.title}\n\n${stage.summary}\n\nReviewed: ${stage.scopeReviewed.join(", ")}\n\nLimitations: ${stage.limitations.join("; ") || "None."}`).join("\n\n")}\n\n## Findings\n\n${review.findings.map((finding) => `### [${finding.severity}] ${finding.title}\n\n- **Fingerprint:** \`${finding.fingerprint}\`\n- **Path:** \`${finding.path}\`\n- **Evidence:** ${finding.evidence}\n- **Impact:** ${finding.impact}\n- **Recommendation:** ${finding.recommendation}\n- **Confidence:** ${finding.confidence}\n- **Limitations:** ${finding.limitations.join("; ") || "None."}`).join("\n\n") || "No evidence-supported findings."}\n\n## Overall limitations\n\n${review.limitations.map((value) => `- ${value}`).join("\n")}\n`;

export async function runStagedRepositoryReview(input: { workspace: string; task: string; reportDirectory?: string; lmStudioUrl?: string; model?: string }): Promise<{ runPath: string; review: StagedReview }> {
  const [evidenceSkill, auditorSkill] = await Promise.all([readFile(resolve(root, "skills/evidence-based-review/SKILL.md"), "utf8"), readFile(resolve(root, "skills/repo-auditor/SKILL.md"), "utf8")]);
  const guard = await WorkspaceGuard.create(input.workspace);
  const runId = randomUUID();
  const runPath = resolve(input.reportDirectory ?? resolve(root, "reports/agent-runs"), `${new Date().toISOString().replace(/[-:.]/g, "")}-github-repo-review-${runId}`);
  await mkdir(runPath, { recursive: true });
  const trace = new JsonlTraceWriter(resolve(runPath, "trace.jsonl"));
  const writer = new ReportWriter();
  const client = createLMStudioModelClient({ config: { ...(input.lmStudioUrl ? { baseUrl: input.lmStudioUrl } : {}), ...(input.model ? { requestedModel: input.model } : {}) } });
  const model = input.model ?? (await client.listModels())[0]?.logicalKey;
  if (!model) throw new Error("No loaded LM Studio model is available for repository review.");
  const tools = ToolFactory.create(guard);
  const inspected = new Set<string>();
  const registry = new ToolRegistry();
  let remainingToolCalls = 20;
  const normal = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const path = (value as Record<string, unknown>)["path"];
    if (typeof path !== "string" || !path.startsWith("/")) return value;
    return { ...(value as Record<string, unknown>), path: path.replace(/^\/+/, "") || "." };
  };  for (const [name, schema, execute] of [["list_files", ListFilesInputSchema, tools.listFiles.execute.bind(tools.listFiles)], ["read_file", ReadFileInputSchema, tools.readFile.execute.bind(tools.readFile)], ["read_file_metadata", ReadFileMetadataInputSchema, tools.readFileMetadata.execute.bind(tools.readFileMetadata)], ["search_text", SearchTextInputSchema, tools.searchText.execute.bind(tools.searchText)]] as const) registry.register({ name, description: `Read-only ${name}`, mutating: false, inputSchema: schema, execute: async (value) => { if (remainingToolCalls-- <= 0) return { status: "TOOL_BUDGET_REACHED", instruction: "Do not call another tool. Synthesize the required structured stage report now using the evidence already collected." }; const result = await execute(normal(value)); if ((name === "read_file" || name === "read_file_metadata") && typeof result === "object" && result && "path" in result && typeof result.path === "string") inspected.add(result.path); return result; } });
  const stages: StagedReview["stages"] = [];
  const candidates: Omit<Finding, "fingerprint">[] = [];
  try {
    for (const [id, title, steps, instruction] of reviewStages) {
      remainingToolCalls = 20;
      const result = await new AgentRunner().run({ id: `github-repo-review:${id}`, allowedTools: ["list_files", "read_file", "read_file_metadata", "search_text"], finalSchema: stageSchema, systemPrompt: `You are the ${title} stage of an exhaustive repository review. ${instruction}\n\nTask: ${input.task}\n\n${evidenceSkill}\n\n${auditorSkill}\n\nRead-only only. Do not run code, commands, builds, Git, package managers, or network requests. Every scopeReviewed and finding path must be directly inspected. Stop tool use by step 20 and return the required structured final report before the stage limit.` }, { runId: `${runId}-${id}`, task: input.task, model, temperature: 0.1, contextTokens: 32768, maxOutputTokens: 4096, maximumSteps: steps, dryRun: true, tools: registry, trace: { record: (event) => trace.append(event) }, validateComplete: (final) => { const value = stageSchema.parse(final); return value.scopeReviewed.some((path) => !inspected.has(path)) || value.findings.some((finding) => !inspected.has(finding.path)) ? "Direct file evidence is required for reviewed paths and findings." : undefined; }, modelClient: { complete: async (request, schema) => { const response = await client.complete({ model: request.model, messages: [...request.messages], temperature: request.temperature, maxTokens: request.maxOutputTokens, structuredOutput: true }, schema); return { parsed: response.value, content: response.content, model: response.model, diagnostics: { serverModel: response.model, outputBytes: Buffer.byteLength(response.content, "utf8") } }; } } });
      const { kind, ...finalReport } = result.final;
      void kind;
      const value = stageSchema.parse(finalReport);
      stages.push({ id, title, summary: value.summary, scopeReviewed: value.scopeReviewed, limitations: value.limitations });
      candidates.push(...value.findings);
    }
    const findings = [...new Map(candidates.map((finding) => { const fingerprint = fingerprintForFinding(finding); return [fingerprint, { ...finding, fingerprint } as Finding]; })).values()];
    const review: StagedReview = { schemaVersion: 1, runId, agent: "github-repo-review", workspace: guard.root, model, baseUrl: client.config.baseUrl, completedStages: reviewStages.map(([id]) => id), stages, findings, limitations: ["Static read-only review only; runtime behavior, credentials, production configuration, and uninspected files are not proven."] };
    await writer.writeJson(resolve(runPath, "result.json"), review);
    await writer.writeJson(resolve(runPath, "run-metadata.json"), { runId, agent: review.agent, workspace: review.workspace, model, baseUrl: review.baseUrl, completedStages: review.completedStages });
    await writeFile(resolve(runPath, "report.md"), markdownStagedReview(review), "utf8");
    await trace.close();
    return { runPath, review };
  } catch (error) { await trace.close(); throw error; }
}