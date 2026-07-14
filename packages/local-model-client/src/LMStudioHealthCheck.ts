import { z } from "zod";

import { ModelClientError, ModelClientErrorCode, redactSensitiveText } from "./errors.js";
import type { LMStudioModelClient } from "./LMStudioModelClient.js";

export const DiagnosticStatusSchema = z.enum(["PASS", "WARNING", "FAIL", "SKIPPED"]);
export type DiagnosticStatus = z.infer<typeof DiagnosticStatusSchema>;

export const DiagnosticCheckSchema = z
  .object({
    name: z.string().min(1),
    status: DiagnosticStatusSchema,
    message: z.string().min(1),
    durationMs: z.number().nonnegative().optional(),
  })
  .strict();
export type DiagnosticCheck = z.infer<typeof DiagnosticCheckSchema>;

export const LMStudioDiagnosticSummarySchema = z
  .object({
    endpoint: z.string().url(),
    requestedModel: z.string().min(1),
    transport: z.enum(["sdk", "rest"]),
    checks: z.array(DiagnosticCheckSchema),
    ok: z.boolean(),
  })
  .strict();
export type LMStudioDiagnosticSummary = z.infer<typeof LMStudioDiagnosticSummarySchema>;

export interface LMStudioHealthCheckOptions {
  readonly runInference?: boolean;
}

function safeFailure(error: unknown): string {
  if (error instanceof ModelClientError) {
    return `${error.code}: ${error.message}`;
  }
  return redactSensitiveText(
    error instanceof Error ? error.message : "Unknown diagnostic failure.",
  );
}

export class LMStudioHealthCheck {
  readonly #client: LMStudioModelClient;

  public constructor(client: LMStudioModelClient) {
    this.#client = client;
  }

  public async run(options: LMStudioHealthCheckOptions = {}): Promise<LMStudioDiagnosticSummary> {
    const checks: DiagnosticCheck[] = [
      {
        name: "endpoint-syntax",
        status: "PASS",
        message: `Loopback LM Studio endpoint accepted: ${this.#client.config.baseUrl}`,
      },
    ];

    try {
      const greeting = await this.#client.greetingCheck();
      checks.push({
        name: "server-greeting",
        status: "PASS",
        message: "The Windows-local LM Studio server greeting responded.",
        durationMs: greeting.durationMs,
      });
    } catch (error) {
      checks.push({
        name: "server-greeting",
        status: "FAIL",
        message: safeFailure(error),
      });
    }

    const health = await this.#client.healthCheck();
    if (!health.ok) {
      checks.push({
        name: "api-reachability",
        status: "FAIL",
        message: health.error?.message ?? "LM Studio endpoint is unavailable.",
        durationMs: health.durationMs,
      });
      checks.push(
        {
          name: "authentication",
          status:
            health.authentication === "required" || health.authentication === "rejected"
              ? "FAIL"
              : "SKIPPED",
          message:
            health.authentication === "required"
              ? "LM Studio requires LM_STUDIO_API_TOKEN."
              : health.authentication === "rejected"
                ? "LM Studio rejected LM_STUDIO_API_TOKEN."
                : "Authentication could not be evaluated.",
        },
        {
          name: "api-compatibility",
          status:
            health.error?.code === ModelClientErrorCode.incompatibleVersion ? "FAIL" : "SKIPPED",
          message:
            health.error?.code === ModelClientErrorCode.incompatibleVersion
              ? health.error.message
              : "Native API compatibility could not be evaluated.",
        },
        {
          name: "sdk-initialization",
          status: "SKIPPED",
          message: "SDK initialization requires a reachable LM Studio server.",
        },
        {
          name: "model-list",
          status: "SKIPPED",
          message: "Model listing requires a reachable endpoint.",
        },
        {
          name: "model-resolution",
          status: "SKIPPED",
          message: "Model resolution requires a reachable endpoint.",
        },
        {
          name: "inference",
          status: "SKIPPED",
          message: "Inference requires a reachable endpoint.",
        },
      );
      return this.#summary(checks);
    }

    checks.push({
      name: "api-reachability",
      status: "PASS",
      message: "Native /api/v1/models responded through Windows localhost.",
      durationMs: health.durationMs,
    });
    checks.push({
      name: "authentication",
      status: "PASS",
      message:
        this.#client.config.apiToken === undefined
          ? "Authentication is disabled or optional; no token was transmitted."
          : "LM Studio accepted the configured API token.",
    });
    checks.push({
      name: "api-compatibility",
      status: health.apiVersion === undefined ? "WARNING" : "PASS",
      message:
        health.apiVersion === undefined
          ? "Native v1 REST is available, but LM Studio did not expose a version header."
          : `LM Studio API version ${health.apiVersion} supports the native v1 path.`,
    });

    if (this.#client.transport === "sdk") {
      try {
        await this.#client.initializeSdk();
        checks.push({
          name: "sdk-initialization",
          status: "PASS",
          message: "@lmstudio/sdk initialized with the derived loopback WebSocket URL.",
        });
      } catch (error) {
        checks.push({
          name: "sdk-initialization",
          status: "FAIL",
          message: safeFailure(error),
        });
      }
    } else {
      checks.push({
        name: "sdk-initialization",
        status: "SKIPPED",
        message: "Token authentication selects LM Studio's authenticated localhost REST transport.",
      });
    }

    let models: Awaited<ReturnType<LMStudioModelClient["listModels"]>> | undefined;
    try {
      models = await this.#client.listModels();
      checks.push({
        name: "model-list",
        status: "PASS",
        message: `LM Studio returned ${models.length} physical model entr${models.length === 1 ? "y" : "ies"}.`,
      });
    } catch (error) {
      checks.push({ name: "model-list", status: "FAIL", message: safeFailure(error) });
    }

    if (models !== undefined) {
      try {
        const resolved = await this.#client.resolveModel(this.#client.config.requestedModel);
        checks.push({
          name: "model-resolution",
          status: "PASS",
          message: `Resolved ${JSON.stringify(resolved.requested)} to exact logical key ${JSON.stringify(resolved.logicalKey)}.`,
        });
        checks.push({
          name: "lm-link-routing",
          status: "WARNING",
          message:
            resolved.variants.length > 1
              ? "Multiple physical variants share this model key. Confirm the Mac is preferred in LM Studio; a Windows-local duplicate may otherwise be selected. Remote Mac execution requires confirmation in LM Studio."
              : "Remote Mac execution requires confirmation in LM Studio.",
        });
      } catch (error) {
        checks.push({
          name: "model-resolution",
          status: "FAIL",
          message: safeFailure(error),
        });
      }
    } else {
      checks.push({
        name: "model-resolution",
        status: "SKIPPED",
        message: "Model resolution requires a successful model listing.",
      });
    }

    if (options.runInference === true && !checks.some((check) => check.status === "FAIL")) {
      const started = performance.now();
      try {
        const response = await this.#client.complete(
          {
            messages: [
              {
                role: "user",
                content: 'Return JSON with one field named "greeting" containing a short greeting.',
              },
            ],
            maxTokens: 64,
          },
          z.object({ greeting: z.string().min(1) }).strict(),
        );
        checks.push({
          name: "inference",
          status: response.value.greeting.trim() === "" ? "FAIL" : "PASS",
          message: "Structured LM Studio inference returned valid non-empty content.",
          durationMs: Math.round(performance.now() - started),
        });
      } catch (error) {
        checks.push({
          name: "inference",
          status: "FAIL",
          message: safeFailure(error),
          durationMs: Math.round(performance.now() - started),
        });
      }
    } else if (options.runInference !== true) {
      checks.push({
        name: "inference",
        status: "SKIPPED",
        message: "Minimal inference is opt-in; pass --inference to run it.",
      });
    } else {
      checks.push({
        name: "inference",
        status: "SKIPPED",
        message: "Inference was skipped because an earlier required check failed.",
      });
    }
    return this.#summary(checks);
  }

  #summary(checks: readonly DiagnosticCheck[]): LMStudioDiagnosticSummary {
    return {
      endpoint: this.#client.config.baseUrl,
      requestedModel: this.#client.config.requestedModel,
      transport: this.#client.transport,
      checks: [...checks],
      ok: !checks.some((check) => check.status === "FAIL"),
    };
  }
}
