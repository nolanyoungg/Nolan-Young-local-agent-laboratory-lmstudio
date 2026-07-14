import { LMStudioHealthCheck } from "@local-agent-lab/local-model-client";

import {
  CLI_EXIT,
  CliUsageError,
  clientFromCli,
  parseDiagnosticArgs,
  printSafeCliError,
  runLmsAdvisory,
} from "./lm-studio-diagnostics-common.js";

const HELP = `Usage: npm run --silent check:lmlink -- [options]

Verifies the observable Windows-local LM Studio path and prints the manual LM Link checklist.
This command never changes LM Link settings and never treats a successful response as proof of Mac execution.

Options:
  --base-url <url>  Override LM_STUDIO_BASE_URL (loopback HTTP only)
  --model <key>     Override LM_STUDIO_MODEL
  --json            Emit machine-readable JSON
  --help, -h        Show this help
`;

const MANUAL_CHECKLIST = [
  "Open LM Studio on Windows.",
  "Open LM Link.",
  "Confirm the Mac is connected.",
  "Confirm the Mac is set as the preferred device.",
  "Confirm the selected model is associated with the Mac.",
  "Observe the active inference device during the test request.",
] as const;

async function main(): Promise<number> {
  const json = process.argv.slice(2).includes("--json");
  try {
    const options = parseDiagnosticArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(HELP);
      return CLI_EXIT.success;
    }
    const client = clientFromCli(options);
    const [summary, linkStatus, processStatus] = await Promise.all([
      new LMStudioHealthCheck(client).run({ runInference: true }),
      runLmsAdvisory(["link", "status", "--json"]),
      runLmsAdvisory(["ps", "--json"]),
    ]);
    const inferenceVerified = summary.checks.some(
      (check) => check.name === "inference" && check.status === "PASS",
    );
    const result = {
      ...summary,
      advisoryChecks: [linkStatus, processStatus],
      manualChecklist: MANUAL_CHECKLIST,
      conclusions: {
        lmStudioPathVerified: summary.ok,
        modelInferenceVerified: inferenceVerified,
        remoteMacExecutionVerified: false,
        message: "Remote Mac execution requires confirmation in LM Studio.",
      },
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
    } else {
      process.stdout.write(`LM Studio endpoint: ${summary.endpoint}\n`);
      process.stdout.write(`Requested model: ${summary.requestedModel}\n\n`);
      for (const check of summary.checks) {
        const timing = check.durationMs === undefined ? "" : ` (${check.durationMs} ms)`;
        process.stdout.write(`[${check.status}] ${check.name}${timing}: ${check.message}\n`);
      }
      for (const check of result.advisoryChecks) {
        process.stdout.write(`[${check.status}] ${check.command}: ${check.message}\n`);
      }
      process.stdout.write("\nManual LM Link checklist:\n");
      for (const item of MANUAL_CHECKLIST) process.stdout.write(`- ${item}\n`);
      process.stdout.write("\n");
      process.stdout.write(
        summary.ok ? "LM Studio path verified.\n" : "LM Studio path not verified.\n",
      );
      process.stdout.write(
        inferenceVerified ? "Model inference verified.\n" : "Model inference not verified.\n",
      );
      process.stdout.write("Remote Mac execution requires confirmation in LM Studio.\n");
    }
    return summary.ok && inferenceVerified ? CLI_EXIT.success : CLI_EXIT.infrastructure;
  } catch (error) {
    printSafeCliError(error, json);
    return error instanceof CliUsageError ? CLI_EXIT.usage : CLI_EXIT.infrastructure;
  }
}

process.exitCode = await main();
