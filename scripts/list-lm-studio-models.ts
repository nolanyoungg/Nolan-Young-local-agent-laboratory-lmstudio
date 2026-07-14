import {
  CLI_EXIT,
  CliUsageError,
  clientFromCli,
  parseDiagnosticArgs,
  printSafeCliError,
} from "./lm-studio-diagnostics-common.js";

const HELP = `Usage: npm run --silent models:lmstudio -- [options]

Lists model identifiers visible through the Windows-local LM Studio endpoint.

Options:
  --base-url <url>  Override LM_STUDIO_BASE_URL (loopback HTTP only)
  --json            Emit machine-readable JSON
  --help, -h        Show this help
`;

async function main(): Promise<number> {
  const json = process.argv.slice(2).includes("--json");
  try {
    const options = parseDiagnosticArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(HELP);
      return CLI_EXIT.success;
    }
    const client = clientFromCli(options);
    const models = await client.listModels();
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            endpoint: client.config.baseUrl,
            models,
            note: "Remote Mac execution requires confirmation in LM Studio.",
          },
          undefined,
          2,
        )}\n`,
      );
      return CLI_EXIT.success;
    }
    process.stdout.write(`LM Studio endpoint: ${client.config.baseUrl}\n`);
    process.stdout.write(`Visible physical entries: ${models.length}\n\n`);
    for (const model of models) {
      process.stdout.write(`${model.logicalKey}\n`);
      process.stdout.write(`  display: ${model.displayName}\n`);
      process.stdout.write(`  variant: ${model.variantId}\n`);
      process.stdout.write(`  type: ${model.type}\n`);
      process.stdout.write(`  format: ${model.format ?? "not reported"}\n`);
      process.stdout.write(
        `  loaded: ${model.loaded === undefined ? "not reported" : String(model.loaded)}\n`,
      );
      process.stdout.write(`  context: ${model.contextLength ?? "not reported"}\n`);
      process.stdout.write(`  capabilities: ${model.capabilities.join(", ") || "not reported"}\n`);
      process.stdout.write(
        `  source/device: ${model.source ?? "not reported"} / ${model.device ?? "not reported"}\n\n`,
      );
    }
    process.stdout.write("Remote Mac execution requires confirmation in LM Studio.\n");
    return CLI_EXIT.success;
  } catch (error) {
    printSafeCliError(error, json);
    return error instanceof CliUsageError ? CLI_EXIT.usage : CLI_EXIT.infrastructure;
  }
}

process.exitCode = await main();
