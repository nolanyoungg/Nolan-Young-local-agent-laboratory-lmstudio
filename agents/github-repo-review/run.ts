process.argv.splice(2, 0, "--agent", "github-repo-review");
await import("../_shared/run-read-only-agent.js");
