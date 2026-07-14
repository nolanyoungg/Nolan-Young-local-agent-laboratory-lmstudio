import { ModelClientError, ModelClientErrorCode } from "./errors.js";

export const DEFAULT_LM_STUDIO_BASE_URL = "http://127.0.0.1:1234";

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
      "LM Studio base URL must be an absolute HTTP loopback URL.",
      { cause: error },
    );
  }

  if (parsed.protocol !== "http:") {
    throw new ModelClientError(
      ModelClientErrorCode.endpointInvalid,
      "LM Studio base URL must use http://; the SDK WebSocket URL is derived internally.",
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ModelClientError(
      ModelClientErrorCode.endpointInvalid,
      "LM Studio base URL must not contain credentials.",
    );
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new ModelClientError(
      ModelClientErrorCode.endpointInvalid,
      "LM Studio base URL must not contain a path, query string, or fragment.",
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") {
    throw new ModelClientError(
      ModelClientErrorCode.endpointInvalid,
      "LM Studio base URL must use a loopback host (127.0.0.1, localhost, or ::1), never a LAN or linked-device address.",
    );
  }

  const port = parsed.port === "" ? "1234" : parsed.port;
  return {
    httpBaseUrl: `http://127.0.0.1:${port}`,
    sdkWebSocketUrl: `ws://127.0.0.1:${port}`,
  };
}

export function lmStudioEndpointUrl(baseUrl: string, path: string): URL {
  const endpoint = validateLMStudioEndpoint(baseUrl);
  return new URL(path, `${endpoint.httpBaseUrl}/`);
}
