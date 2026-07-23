process.argv.splice(2, 0, "--agent", "agent-definition-auditor");
await import("./workflow.js");
