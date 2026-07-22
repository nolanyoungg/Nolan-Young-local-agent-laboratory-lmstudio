import { ModelClientError, ModelClientErrorCode } from "./errors.js";

/** The documented OpenAI-compatible LM Studio API base. */
export const DEFAULT_LM_STUDIO_BASE_URL = "http://127.0.0.1:1234/v1";

export interface ValidatedLMStudioEndpoint {
  readonly httpBaseUrl: string;
  readonly sdkWebSocketUrl: string;
}

export function validateLMStudioEndpoint(value: string): ValidatedLMStudioEndpoint {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new ModelClientError(
      ModelClientErrorCode.endpointInvalid,
      "LM Studio base URL must be an absolute HTTP(S) URL.",
      { cause: error },
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ModelClientError(
      ModelClientErrorCode.endpointInvalid,
      "LM Studio base URL must use http:// (loopback only) or https:// (for LM Link-compatible remote access).",
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ModelClientError(
      ModelClientErrorCode.endpointInvalid,
      "LM Studio base URL must not contain credentials.",
    );
  }
  if (
    (parsed.pathname !== "/" && parsed.pathname !== "/v1") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new ModelClientError(
      ModelClientErrorCode.endpointInvalid,
      "LM Studio base URL may only contain the documented /v1 path and must not contain a query string or fragment.",
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  if (parsed.protocol === "http:" && !loopback) {
    throw new ModelClientError(
      ModelClientErrorCode.endpointInvalid,
      "HTTP LM Studio URLs must use a loopback host (127.0.0.1, localhost, or ::1). Use HTTPS for LM Link-compatible remote access.",
    );
  }

  const port = parsed.port === "" ? (parsed.protocol === "http:" ? "1234" : "") : `:${parsed.port}`;
  return {
    httpBaseUrl: `${parsed.protocol}//${parsed.hostname}${port}/v1`,
    sdkWebSocketUrl: `${parsed.protocol === "https:" ? "wss:" : "ws:"}//${parsed.host}`,
  };
}

export function lmStudioEndpointUrl(baseUrl: string, path: string): URL {
  const endpoint = validateLMStudioEndpoint(baseUrl);
  return new URL(path.replace(/^\/v1\/?/u, ""), `${endpoint.httpBaseUrl}/`);
}

/** Builds a URL for LM Studio's native REST API without changing the configured host. */
export function lmStudioNativeEndpointUrl(baseUrl: string, path: string): URL {
  const endpoint = validateLMStudioEndpoint(baseUrl);
  const origin = new URL(endpoint.httpBaseUrl).origin;
  return new URL(path.replace(/^\/+/u, ""), `${origin}/`);
}
