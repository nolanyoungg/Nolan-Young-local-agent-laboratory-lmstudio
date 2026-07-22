process.argv.splice(2, 0, "--agent", "wordpress-theme-verification-agent");
await import("../_shared/run-read-only-agent.js");
