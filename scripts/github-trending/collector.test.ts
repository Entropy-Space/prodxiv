import { describe, expect, test } from "bun:test";

import {
  collectTrendingSnapshots,
  defaultLanguages,
  parseTrendingHtml,
  snapshotFileName,
  TrendingParseError,
  trendingUrl,
} from "./collector.ts";
import { parseArguments } from "./cli.ts";

const fixture = await Bun.file(
  new URL("./fixtures/trending.html", import.meta.url),
).text();

describe("GitHub Trending collector", () => {
  test("parses repository identity and every numeric observation", () => {
    const entries = parseTrendingHtml(fixture);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      repository_full_name: "acme/alpha",
      repository_node_id: null,
      description: "A useful tool",
      primary_language: "Rust",
      stars: 12_345,
      forks: 678,
      stars_in_period: 91,
    });
    expect(entries[1]).toEqual({
      repository_full_name: "acme/no-description",
      repository_node_id: null,
      description: null,
      primary_language: null,
      stars: 9,
      forks: 0,
      stars_in_period: 1,
    });
  });

  test("distinguishes empty results from invalid documents", () => {
    expect(parseTrendingHtml("<div data-hpc></div>")).toEqual([]);
    expect(() => parseTrendingHtml("<html></html>")).toThrow(
      TrendingParseError,
    );
  });

  test("encodes special language routes and safe filenames", () => {
    expect(trendingUrl("c#")).toBe(
      "https://github.com/trending/c%23?since=daily",
    );
    expect(trendingUrl("c++")).toBe(
      "https://github.com/trending/c%2B%2B?since=daily",
    );
    expect(trendingUrl("any")).toBe("https://github.com/trending?since=daily");
    expect(() => trendingUrl("all")).toThrow(
      "snapshot language must be any or a concrete",
    );
    expect(snapshotFileName("any")).toBe("any.json");
    expect(snapshotFileName("c#")).toBe("c-sharp.json");
    expect(snapshotFileName("c++")).toBe("c-plus-plus.json");
  });

  test("builds deterministic snapshots from an injected fetcher", async () => {
    const fetcher: typeof fetch = Object.assign(
      async () => new Response(fixture, { status: 200 }),
      { preconnect: fetch.preconnect },
    );
    const result = await collectTrendingSnapshots(
      {
        snapshot_date: "2026-07-30",
        captured_at: "2026-07-30T02:17:00Z",
        languages: ["any", "rust"],
      },
      fetcher,
    );

    expect(result.failures).toEqual([]);
    expect(result.snapshots).toHaveLength(2);
    expect(result.snapshots[0]?.source_revision).toBe(
      result.snapshots[1]?.source_revision,
    );
    expect(result.snapshots[1]?.language).toBe("rust");
  });

  test("parses and validates workflow arguments", () => {
    const arguments_ = parseArguments([
      "--snapshot-date",
      "2026-07-30",
      "--captured-at",
      "2026-07-30T02:17:00Z",
      "--language",
      "C#",
    ]);

    expect(arguments_.languages).toEqual(["c#"]);
    expect(
      parseArguments([
        "--snapshot-date",
        "2026-07-30",
        "--captured-at",
        "2026-07-30T02:17:00Z",
        "--language",
        "any",
      ]).languages,
    ).toEqual(["any"]);
    expect(
      parseArguments([
        "--snapshot-date",
        "2026-07-30",
        "--captured-at",
        "2026-07-30T02:17:00Z",
        "--language",
        "all",
      ]).languages,
    ).toEqual(["any", ...defaultLanguages]);
    expect(() =>
      parseArguments([
        "--snapshot-date",
        "2026-07-30",
        "--captured-at",
        "2026-07-30T02:17:00Z",
        "--language",
        "all",
        "--language",
        "rust",
      ]),
    ).toThrow("cannot be combined");
    expect(() =>
      parseArguments([
        "--snapshot-date",
        "2026-02-30",
        "--captured-at",
        "2026-07-30T02:17:00Z",
      ]),
    ).toThrow("real YYYY-MM-DD");
    expect(() =>
      parseArguments([
        "--snapshot-date",
        "9999-99-99",
        "--captured-at",
        "2026-07-30T02:17:00Z",
      ]),
    ).toThrow("real YYYY-MM-DD");
    expect(() =>
      parseArguments([
        "--snapshot-date",
        "2026-07-30",
        "--captured-at",
        "2026-07-30T02:17:00Z",
        "--language",
        "../rust",
      ]),
    ).toThrow("invalid language slug");
    expect(() =>
      parseArguments([
        "--snapshot-date",
        "2026-07-29",
        "--captured-at",
        "2026-07-30T02:17:00Z",
      ]),
    ).toThrow("must match the UTC date");
  });
});
