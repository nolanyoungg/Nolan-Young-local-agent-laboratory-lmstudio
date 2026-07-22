process.argv.splice(2, 0, "--agent", "wordpress-homepage-template-composer-agent");
await import("../_shared/run-write-agent.js");
