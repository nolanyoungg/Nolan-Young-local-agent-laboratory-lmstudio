import type { LMStudioConnectionConfig, LocalModelClient } from "./LocalModelClient.js";
import { LMStudioConnectionConfigSchema } from "./LocalModelClient.js";
import { ModelClientError, ModelClientErrorCode } from "./errors.js";
import { DEFAULT_LM_STUDIO_BASE_URL, validateLMStudioEndpoint } from "./LMStudioEndpoint.js";
import {
  LMStudioModelClient,
  type LMStudioModelClientDependencies,
} from "./LMStudioModelClient.js";
import { AUTO_SELECT_LOADED_MODEL } from "./LMStudioModelResolver.js";
import { MockModelClient, type MockModelClientOptions } from "./MockModelClient.js";

const DEFAULTS = {
  requestedModel: AUTO_SELECT_LOADED_MODEL,
  contextLength: 32_768,
  temperature: 0.1,
  maxTokens: 4_096,
  connectionTimeoutMs: 15_000,
  resolutionTimeoutMs: 30_000,
  loadTimeoutMs: 180_000,
  predictionTimeoutMs: 300_000,
  maxRetries: 2,
  retryDelayMs: 1_000,
} as const;

function envNumber(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ModelClientError(
      ModelClientErrorCode.configurationInvalid,
      `${name} must be a finite number.`,
    );
  }
  return value;
}

function envNumberWithCompatibility(
  environment: NodeJS.ProcessEnv,
  primaryName: string,
  compatibilityName: string,
  fallback: number,
): number {
  const primary = environment[primaryName];
  if (primary !== undefined && primary.trim() !== "") {
    return envNumber(environment, primaryName, fallback);
  }
  return envNumber(environment, compatibilityName, fallback);
}

export function createLMStudioConnectionConfig(
  overrides: Partial<LMStudioConnectionConfig> = {},
  environment: NodeJS.ProcessEnv = process.env,
): LMStudioConnectionConfig {
  const configuredBaseUrl =
    overrides.baseUrl ??
    environment["LMSTUDIO_BASE_URL"] ??
    environment["LM_STUDIO_BASE_URL"] ??
    DEFAULT_LM_STUDIO_BASE_URL;
  const endpoint = validateLMStudioEndpoint(configuredBaseUrl);
  const configuredToken =
    overrides.apiToken ?? environment["LMSTUDIO_API_TOKEN"] ?? environment["LM_STUDIO_API_TOKEN"];
  const apiToken = configuredToken?.trim() === "" ? undefined : configuredToken?.trim();

  const candidate = {
    baseUrl: endpoint.httpBaseUrl,
    requestedModel:
      overrides.requestedModel ??
      environment["LMSTUDIO_MODEL"] ??
      environment["LM_STUDIO_MODEL"] ??
      DEFAULTS.requestedModel,
    contextLength:
      overrides.contextLength ??
      envNumber(environment, "MODEL_CONTEXT_TOKENS", DEFAULTS.contextLength),
    temperature:
      overrides.temperature ?? envNumber(environment, "MODEL_TEMPERATURE", DEFAULTS.temperature),
    maxTokens:
      overrides.maxTokens ?? envNumber(environment, "MODEL_MAX_OUTPUT_TOKENS", DEFAULTS.maxTokens),
    connectionTimeoutMs:
      overrides.connectionTimeoutMs ??
      envNumber(environment, "MODEL_CONNECTION_TIMEOUT_MS", DEFAULTS.connectionTimeoutMs),
    resolutionTimeoutMs:
      overrides.resolutionTimeoutMs ??
      envNumber(environment, "MODEL_RESOLUTION_TIMEOUT_MS", DEFAULTS.resolutionTimeoutMs),
    loadTimeoutMs:
      overrides.loadTimeoutMs ??
      envNumber(environment, "MODEL_LOAD_TIMEOUT_MS", DEFAULTS.loadTimeoutMs),
    predictionTimeoutMs:
      overrides.predictionTimeoutMs ??
      envNumberWithCompatibility(
        environment,
        "MODEL_REQUEST_TIMEOUT_MS",
        "MODEL_PREDICTION_TIMEOUT_MS",
        DEFAULTS.predictionTimeoutMs,
      ),
    maxRetries:
      overrides.maxRetries ?? envNumber(environment, "MODEL_MAX_RETRIES", DEFAULTS.maxRetries),
    retryDelayMs:
      overrides.retryDelayMs ??
      envNumber(environment, "MODEL_RETRY_DELAY_MS", DEFAULTS.retryDelayMs),
    ...(apiToken === undefined ? {} : { apiToken }),
  };
  const result = LMStudioConnectionConfigSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".")}: ${issue.code}`)
      .join("; ");
    throw new ModelClientError(
      ModelClientErrorCode.configurationInvalid,
      `LM Studio configuration is invalid (${issues}).`,
    );
  }
  return result.data;
}

export interface CreateLMStudioModelClientOptions {
  readonly config?: Partial<LMStudioConnectionConfig>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly dependencies?: LMStudioModelClientDependencies;
}

export function createLMStudioModelClient(
  options: CreateLMStudioModelClientOptions = {},
): LMStudioModelClient {
  const config = createLMStudioConnectionConfig(
    options.config ?? {},
    options.environment ?? process.env,
  );
  return new LMStudioModelClient(config, options.dependencies ?? {});
}

export type LocalModelProviderOptions =
  | ({ readonly provider: "lmstudio" } & CreateLMStudioModelClientOptions)
  | { readonly provider: "mock"; readonly mock: MockModelClientOptions };

export function createLocalModelClient(options: LocalModelProviderOptions): LocalModelClient {
  if (options.provider === "mock") {
    return new MockModelClient(options.mock);
  }
  return createLMStudioModelClient(options);
}

export class LMStudioClientFactory {
  public static create(options: CreateLMStudioModelClientOptions = {}): LMStudioModelClient {
    return createLMStudioModelClient(options);
  }
}
