import { describe, expect, test } from "bun:test";

import type { TrendingSnapshot } from "./collector.ts";
import {
  publishTrendingSnapshots,
  readIngestionConfig,
  snapshotIdempotencyKey,
} from "./publisher.ts";

const snapshot: TrendingSnapshot = {
  snapshot_date: "2026-07-31",
  captured_at: "2026-07-31T02:17:00Z",
  period: "daily",
  language: "c#",
  spoken_language: null,
  source_kind: "direct_fetch",
  source_url: "https://github.com/trending/c%23?since=daily",
  source_revision: `sha256:${"a".repeat(64)}`,
  entries: [
    {
      repository_full_name: "acme/example",
      repository_node_id: null,
      description: "An example",
      primary_language: "C#",
      stars: 100,
      forks: 10,
      stars_in_period: 5,
    },
  ],
};

describe("GitHub Trending publisher", () => {
  test("loads a scoped API credential without allowing insecure remote URLs", () => {
    expect(
      readIngestionConfig({
        PRODXIV_API_URL: "https://api.prodxiv.com/",
        PRODXIV_TRENDING_INGEST_TOKEN: "x".repeat(32),
        PRODXIV_TRENDING_INGEST_ACTOR: "github_actions:daily_trending",
      }),
    ).toEqual({
      api_url: "https://api.prodxiv.com",
      ingest_token: "x".repeat(32),
      ingest_actor: "github_actions:daily_trending",
    });
    expect(() =>
      readIngestionConfig({
        PRODXIV_API_URL: "http://api.prodxiv.com",
        PRODXIV_TRENDING_INGEST_TOKEN: "x".repeat(32),
        PRODXIV_TRENDING_INGEST_ACTOR: "github_actions:daily_trending",
      }),
    ).toThrow("must use HTTPS");
  });

  test("builds a stable, valid idempotency key", () => {
    expect(snapshotIdempotencyKey(snapshot)).toBe(
      `github-trending:2026-07-31:c-sharp:${"a".repeat(64)}`,
    );
  });

  test("posts the exact snapshot with authentication", async () => {
    let request: Request | undefined;
    const fetcher = mockFetch(async (input, init) => {
      request = new Request(input, init);
      return Response.json(
        { snapshot_id: 42, entry_count: 1, inserted: true },
        { status: 201 },
      );
    });
    const result = await publishTrendingSnapshots(
      [snapshot],
      {
        api_url: "https://api.prodxiv.com",
        ingest_token: "x".repeat(32),
        ingest_actor: "github_actions:daily_trending",
      },
      fetcher,
    );

    expect(result).toEqual({ published_count: 1, failures: [] });
    expect(request?.url).toBe(
      "https://api.prodxiv.com/v1/github/trending/snapshots",
    );
    expect(request?.headers.get("authorization")).toBe(
      `Bearer ${"x".repeat(32)}`,
    );
    expect(request?.headers.get("idempotency-key")).toBe(
      snapshotIdempotencyKey(snapshot),
    );
    expect(request?.headers.get("x-prodxiv-actor")).toBe(
      "github_actions:daily_trending",
    );
    expect(await request?.json()).toEqual(snapshot);
  });

  test("loads authentication lazily and refreshes it for each snapshot and retry", async () => {
    const tokens = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
    let providerCalls = 0;
    const config = readIngestionConfig(
      { PRODXIV_API_URL: "https://api.prodxiv.com" },
      async () => tokens[providerCalls++]!,
    );
    expect(providerCalls).toBe(0);
    const authorization: Array<string | null> = [];
    const fetcher = mockFetch(async (input, init) => {
      authorization.push(new Request(input, init).headers.get("authorization"));
      if (authorization.length === 1) {
        return Response.json({}, { status: 503 });
      }
      return Response.json(
        { snapshot_id: authorization.length, entry_count: 1, inserted: true },
        { status: 201 },
      );
    });

    const result = await publishTrendingSnapshots(
      [snapshot, { ...snapshot, language: "rust" }],
      config,
      fetcher,
    );

    expect(result).toEqual({ published_count: 2, failures: [] });
    expect(providerCalls).toBe(3);
    expect(authorization).toEqual(tokens.map((token) => `Bearer ${token}`));
  });

  test("sanitizes credential provider failures and continues with later snapshots", async () => {
    let providerCalls = 0;
    let requestCalls = 0;
    const result = await publishTrendingSnapshots(
      [snapshot, { ...snapshot, language: "rust" }],
      {
        api_url: "https://api.prodxiv.com",
        ingest_actor: "github_actions:daily_trending",
        token_provider: async () => {
          providerCalls += 1;
          if (providerCalls === 1) {
            throw new Error("request failed with Bearer secret-token");
          }
          return "x".repeat(32);
        },
      },
      mockFetch(async () => {
        requestCalls += 1;
        return Response.json(
          { snapshot_id: 42, entry_count: 1, inserted: true },
          { status: 201 },
        );
      }),
    );

    expect(providerCalls).toBe(2);
    expect(requestCalls).toBe(1);
    expect(result).toEqual({
      published_count: 1,
      failures: [
        { language: "c#", message: "ingestion API authentication failed" },
      ],
    });
  });

  test("rejects invalid dynamic credentials before sending a request", async () => {
    let calls = 0;
    const result = await publishTrendingSnapshots(
      [snapshot],
      {
        api_url: "https://api.prodxiv.com",
        ingest_actor: "github_actions:daily_trending",
        token_provider: async () => `secret\n${"x".repeat(32)}`,
      },
      mockFetch(async () => {
        calls += 1;
        return Response.json({});
      }),
    );

    expect(calls).toBe(0);
    expect(result.failures).toEqual([
      { language: "c#", message: "ingestion API bearer token is invalid" },
    ]);
  });

  test("does not retry a rejected snapshot", async () => {
    let calls = 0;
    const fetcher = mockFetch(async () => {
      calls += 1;
      return Response.json(
        { error: { message: "snapshot failed validation" } },
        { status: 422 },
      );
    });
    const result = await publishTrendingSnapshots(
      [snapshot],
      {
        api_url: "https://api.prodxiv.com",
        ingest_token: "x".repeat(32),
        ingest_actor: "github_actions:daily_trending",
      },
      fetcher,
    );

    expect(calls).toBe(1);
    expect(result.published_count).toBe(0);
    expect(result.failures).toEqual([
      {
        language: "c#",
        message: "ingestion API returned HTTP 422: snapshot failed validation",
      },
    ]);
  });
});

function mockFetch(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return Object.assign(implementation, { preconnect: fetch.preconnect });
}
