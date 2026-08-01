import { ExitCode, PaperbotError } from "@prodxiv/paperbot-core";

const LOCAL_ROUTER_FALLBACK_API_KEY = "paperbot-local-router";

export interface PiConnectionOptions {
  api_key?: string;
  base_url?: string;
}

export interface ResolvedPiConnection {
  api_key: string;
  base_url?: string;
}

export interface PiEnvironment {
  [name: string]: string | undefined;
  DEEPSEEK_API_KEY?: string;
  PAPERBOT_MODEL_API_KEY?: string;
  PAPERBOT_MODEL_BASE_URL?: string;
  TOKN_API_KEY?: string;
}

/**
 * Resolve the model transport without relying on Pi's user-level config
 * files. A keyless router is deliberately supported only on loopback, where
 * Pi's required API-key value is a non-secret transport placeholder.
 */
export function resolvePiConnection(
  options: PiConnectionOptions = {},
  environment: PiEnvironment = process.env,
): ResolvedPiConnection {
  const configuredBaseUrl =
    options.base_url ?? environment.PAPERBOT_MODEL_BASE_URL;
  if (configuredBaseUrl !== undefined) {
    const baseUrl = normalizeLoopbackBaseUrl(configuredBaseUrl);
    return {
      api_key:
        firstNonBlank(
          options.api_key,
          environment.PAPERBOT_MODEL_API_KEY,
          environment.TOKN_API_KEY,
        ) ?? LOCAL_ROUTER_FALLBACK_API_KEY,
      base_url: baseUrl,
    };
  }

  const apiKey = firstNonBlank(options.api_key, environment.DEEPSEEK_API_KEY);
  if (apiKey === undefined) {
    throw new PaperbotError(
      "DEEPSEEK_API_KEY is required when PAPERBOT_MODEL_BASE_URL is not configured",
      ExitCode.auth,
    );
  }
  return { api_key: apiKey };
}

export function redactModelSecrets(
  message: string,
  additionalSecrets: readonly string[] = [],
  environment: PiEnvironment = process.env,
): string {
  const secrets = [
    environment.DEEPSEEK_API_KEY,
    environment.PAPERBOT_MODEL_API_KEY,
    environment.TOKN_API_KEY,
    ...additionalSecrets,
  ].filter((value): value is string => value !== undefined && value.length > 0);
  return [...new Set(secrets)].reduce(
    (redacted, secret) => redacted.replaceAll(secret, "[redacted]"),
    message,
  );
}

export function normalizeLoopbackBaseUrl(value: string): string {
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalidBaseUrl();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidBaseUrl();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !isLoopbackHost(url.hostname)
  ) {
    throw invalidBaseUrl();
  }
  return url.toString().replace(/\/+$/, "");
}

function firstNonBlank(
  ...values: Array<string | undefined>
): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function invalidBaseUrl(): PaperbotError {
  return new PaperbotError(
    "PAPERBOT_MODEL_BASE_URL must be an anonymous loopback HTTP(S) URL",
    ExitCode.auth,
  );
}
