import { LMStudioHealthCheck } from "@local-agent-lab/local-model-client";

import {
  CLI_EXIT,
  CliUsageError,
  clientFromCli,
  parseDiagnosticArgs,
  printDiagnosticSummary,
  printSafeCliError,
} from "./lm-studio-diagnostics-common.js";

const HELP = `Usage: npm run --silent check:lmstudio -- [options]

Checks the local LM Studio control plane and configured model.

Options:
  --base-url <url>  Override LM_STUDIO_BASE_URL (loopback HTTP only)
  --model <key>     Override LM_STUDIO_MODEL
  --inference       Run a short structured completion (may load the model)
  --json            Emit machine-readable JSON
  --help, -h        Show this help
`;

async function main(): Promise<number> {
  const json = process.argv.slice(2).includes("--json");
  try {
    const options = parseDiagnosticArgs(process.argv.slice(2), { supportsInference: true });
    if (options.help) {
      process.stdout.write(HELP);
      return CLI_EXIT.success;
    }
    const summary = await new LMStudioHealthCheck(clientFromCli(options)).run({
      runInference: options.inference,
    });
    printDiagnosticSummary(summary, options.json);
    return summary.ok ? CLI_EXIT.success : CLI_EXIT.infrastructure;
  } catch (error) {
    printSafeCliError(error, json);
    return error instanceof CliUsageError ? CLI_EXIT.usage : CLI_EXIT.infrastructure;
  }
}

process.exitCode = await main();
