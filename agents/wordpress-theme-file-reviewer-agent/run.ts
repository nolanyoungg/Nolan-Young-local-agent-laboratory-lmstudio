process.argv.splice(2, 0, "--agent", "wordpress-theme-file-reviewer-agent");
await import("../_shared/run-read-only-agent.js");
