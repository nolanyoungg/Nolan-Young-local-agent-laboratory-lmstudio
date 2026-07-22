import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { validateLMStudioEndpoint } from "@local-agent-lab/local-model-client";
import { assertAgentExecutionMode, listAgents, loadAgent } from "./agent-library.js";

const root = resolve(import.meta.dirname, "..", "..");

describe("agent library", () => {
  it("loads read-only and write-capable agents into their separate modes", async () => {
    expect(await listAgents(root)).toEqual([
      "agent-definition-auditor",
      "github-repo-review",
      "wordpress-blog-writer-agent",
      "wordpress-homepage-template-composer-agent",
      "wordpress-theme-file-reviewer-agent",
      "wordpress-theme-verification-agent",
    ]);
    expect((await loadAgent(root, "agent-definition-auditor")).defaultSkills).toEqual([
      "evidence-based-review",
      "agent-definition-audit",
    ]);
    expect((await loadAgent(root, "github-repo-review")).allowedTools).toEqual([
      "list_files",
      "read_file",
      "read_file_metadata",
      "search_text",
    ]);
    const writer = await loadAgent(root, "wordpress-homepage-template-composer-agent");
    const reader = await loadAgent(root, "github-repo-review");
    expect(writer.executionMode).toBe("write");
    expect(writer.allowedTools).toContain("create_file");
    expect(() => assertAgentExecutionMode(writer, "read-only")).toThrow(/matching agent command/);
    expect(() => assertAgentExecutionMode(reader, "write")).toThrow(/matching agent command/);
  });

  it("accepts loopback HTTP and remote HTTPS without URL credentials", () => {
    expect(validateLMStudioEndpoint("http://127.0.0.1:1234/v1").httpBaseUrl).toBe(
      "http://127.0.0.1:1234/v1",
    );
    expect(validateLMStudioEndpoint("https://lm-link.example/v1").httpBaseUrl).toBe(
      "https://lm-link.example/v1",
    );
    expect(() => validateLMStudioEndpoint("http://192.168.1.20:1234")).toThrow();
    expect(() => validateLMStudioEndpoint("https://token@example.test/v1")).toThrow();
  });
});
