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
      }),
    ).toEqual({
      api_url: "https://api.prodxiv.com",
      ingest_token: "x".repeat(32),
    });
    expect(() =>
      readIngestionConfig({
        PRODXIV_API_URL: "http://api.prodxiv.com",
        PRODXIV_TRENDING_INGEST_TOKEN: "x".repeat(32),
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
    expect(await request?.json()).toEqual(snapshot);
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
