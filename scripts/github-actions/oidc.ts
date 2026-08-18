export const PRODXIV_GITHUB_OIDC_AUDIENCE = "prodxiv-api";

export type StaticApiTokenName =
  "PRODXIV_BOT_TOKEN" | "PRODXIV_TRENDING_INGEST_TOKEN";

export async function resolveApiBearerToken(
  staticTokenName: StaticApiTokenName,
  environment: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const staticToken = environment[staticTokenName];
  if (staticToken !== undefined && staticToken.length > 0) {
    if (staticToken.length < 32 || staticToken.trim() !== staticToken) {
      throw new Error(
        `${staticTokenName} must contain at least 32 non-whitespace-delimited characters`,
      );
    }
    return staticToken;
  }

  const requestUrlValue = environment.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (requestUrlValue === undefined || requestToken === undefined) {
    throw new Error(
      `${staticTokenName} or GitHub Actions OIDC identity is required`,
    );
  }
  const requestUrl = new URL(requestUrlValue);
  if (
    requestUrl.protocol !== "https:" ||
    !requestUrl.hostname.endsWith(".actions.githubusercontent.com")
  ) {
    throw new Error(
      "ACTIONS_ID_TOKEN_REQUEST_URL must use a GitHub Actions HTTPS host",
    );
  }
  requestUrl.searchParams.set("audience", PRODXIV_GITHUB_OIDC_AUDIENCE);

  const response = await fetcher(requestUrl, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${requestToken}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub Actions OIDC token request returned HTTP ${response.status}`,
    );
  }
  const responseText = await response.text();
  if (responseText.length > 64 * 1024) {
    throw new Error("GitHub Actions OIDC token response was too large");
  }
  let responseBody: unknown;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    throw new Error("GitHub Actions OIDC token response was invalid JSON");
  }
  if (
    !isRecord(responseBody) ||
    typeof responseBody.value !== "string" ||
    responseBody.value.length === 0 ||
    responseBody.value.length > 16 * 1024 ||
    responseBody.value.split(".").length !== 3 ||
    /\s/.test(responseBody.value)
  ) {
    throw new Error("GitHub Actions OIDC token response did not contain a JWT");
  }
  return responseBody.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
