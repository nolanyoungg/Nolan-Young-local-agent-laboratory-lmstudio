process.argv.splice(2, 0, "--agent", "wordpress-theme-file-reviewer-agent");
await import("./runner.js");
