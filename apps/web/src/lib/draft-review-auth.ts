import { ProdxivApiClient, ProdxivApiError } from "@prodxiv/api-client";
import { configuredApiUrl } from "./api-url.ts";

export function draftReviewClient(
  request: Request,
  apiUrl: string | undefined,
): ProdxivApiClient | undefined {
  const token = basicPassword(request.headers.get("authorization"));
  const configuredUrl = configuredApiUrl(apiUrl);
  if (token === undefined || configuredUrl === undefined) {
    return undefined;
  }
  return new ProdxivApiClient({ api_url: configuredUrl, token });
}

export function draftReviewChallenge(): Response {
  return new Response("Draft review authentication is required.\n", {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "www-authenticate": 'Basic realm="prodxiv draft review", charset="UTF-8"',
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

export function isSameOriginSubmission(request: Request): boolean {
  if (request.method !== "POST") {
    return true;
  }
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

export function reviewErrorMessage(error: unknown): string {
  if (error instanceof ProdxivApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : "Draft review failed.";
}

export function isUnauthorizedReviewError(error: unknown): boolean {
  return error instanceof ProdxivApiError && error.status === 401;
}

function basicPassword(header: string | null): string | undefined {
  if (header === null) {
    return undefined;
  }
  const [scheme, encoded, ...extra] = header.trim().split(/\s+/);
  if (
    scheme?.toLowerCase() !== "basic" ||
    encoded === undefined ||
    extra.length > 0
  ) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const separator = decoded.indexOf(":");
  if (separator <= 0 || separator === decoded.length - 1) {
    return undefined;
  }
  return decoded.slice(separator + 1);
}
