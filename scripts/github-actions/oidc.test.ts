import { expect, test } from "bun:test";

import { PRODXIV_GITHUB_OIDC_AUDIENCE, resolveApiBearerToken } from "./oidc.ts";

test("prefers a configured static fallback without requesting OIDC", async () => {
  let requested = false;
  const token = "x".repeat(32);
  expect(
    await resolveApiBearerToken(
      "PRODXIV_BOT_TOKEN",
      { PRODXIV_BOT_TOKEN: token },
      mockFetch(async () => {
        requested = true;
        return Response.json({ value: "unused.token.value" });
      }),
    ),
  ).toBe(token);
  expect(requested).toBe(false);
});

test("requests a GitHub Actions token for the prodxiv API audience", async () => {
  let request: Request | undefined;
  const token = "header.payload.signature";
  const resolved = await resolveApiBearerToken(
    "PRODXIV_BOT_TOKEN",
    {
      ACTIONS_ID_TOKEN_REQUEST_URL:
        "https://pipelines.actions.githubusercontent.com/example?api-version=2.0",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-request-token",
    },
    mockFetch(async (input, init) => {
      request = new Request(input, init);
      return Response.json({ value: token });
    }),
  );

  expect(resolved).toBe(token);
  expect(request?.headers.get("authorization")).toBe(
    "Bearer runner-request-token",
  );
  expect(new URL(request?.url ?? "").searchParams.get("audience")).toBe(
    PRODXIV_GITHUB_OIDC_AUDIENCE,
  );
});

test("does not send the runner request token to another host", async () => {
  expect(
    resolveApiBearerToken("PRODXIV_BOT_TOKEN", {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.com/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-request-token",
    }),
  ).rejects.toThrow("GitHub Actions HTTPS host");
});

function mockFetch(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return Object.assign(implementation, { preconnect: fetch.preconnect });
}
