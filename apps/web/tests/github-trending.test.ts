import { describe, expect, test } from "bun:test";

import {
  readGitHubTrending,
  readGitHubTrendingDay,
} from "../src/lib/github-trending.ts";

describe("readGitHubTrending", () => {
  test("returns the latest imported snapshot", async () => {
    let requestedUrl = "";
    const result = await readGitHubTrending({
      api_url: "https://api.prodxiv.example",
      period: "daily",
      fetch: async (input) => {
        requestedUrl = String(input);
        return Response.json({
          requested_language: "any",
          previous_date: "2026-07-28",
          next_date: "2026-07-30",
          available_languages: ["rust", "typescript"],
          snapshots: [
            {
              snapshot_date: "2026-07-29",
              captured_at: null,
              period: "daily",
              language: "any",
              spoken_language: null,
              source_kind: "third_party_archive",
              source_url: "https://example.com/archive",
              source_revision: "abc123",
              entries: [
                {
                  rank: 1,
                  repository_full_name: "pascalorg/editor",
                  repository_node_id: null,
                  repository_url: "https://github.com/pascalorg/editor",
                  description: "A repository",
                  primary_language: "TypeScript",
                  stars: null,
                  forks: null,
                  stars_in_period: null,
                },
              ],
            },
          ],
        });
      },
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.view.snapshots[0]?.entries[0]?.rank).toBe(1);
    expect(result.ok && result.view.next_date).toBe("2026-07-30");
    expect(requestedUrl).toContain("language=any");
  });

  test("does not expose API failure details", async () => {
    const result = await readGitHubTrending({
      api_url: "https://api.prodxiv.example",
      fetch: async () => {
        throw new Error("private database details");
      },
    });

    expect(result).toEqual({
      ok: false,
      message: "GitHub Trending observations could not be loaded.",
    });
  });
});

describe("readGitHubTrendingDay", () => {
  test("loads every language scope recorded for the selected day", async () => {
    const requestedUrls: string[] = [];
    const result = await readGitHubTrendingDay({
      api_url: "https://api.prodxiv.example",
      date: "2026-07-29",
      period: "daily",
      fetch: async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        return Response.json({
          requested_language: "all",
          previous_date: null,
          next_date: null,
          available_languages: ["rust", "typescript"],
          snapshots: ["any", "rust", "typescript"].map((scope) => ({
            snapshot_date: "2026-07-29",
            captured_at: null,
            period: "daily",
            language: scope,
            spoken_language: null,
            source_kind: "github_trending",
            source_url: "https://github.com/trending",
            source_revision: `revision-${scope}`,
            entries: [],
          })),
        });
      },
    });

    expect(
      result.ok && result.snapshots.map((snapshot) => snapshot.language),
    ).toEqual(["any", "rust", "typescript"]);
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain("language=all");
  });

  test("fails the complete export when the aggregate request fails", async () => {
    const result = await readGitHubTrendingDay({
      api_url: "https://api.prodxiv.example",
      date: "2026-07-29",
      fetch: async () => {
        throw new Error("archive unavailable");
      },
    });

    expect(result).toEqual({
      ok: false,
      message: "GitHub Trending observations could not be loaded.",
    });
  });

  test("rejects a malformed aggregate response", async () => {
    const result = await readGitHubTrendingDay({
      api_url: "https://api.prodxiv.example",
      date: "2026-07-29",
      fetch: async () =>
        Response.json({
          requested_language: "all",
          previous_date: null,
          next_date: null,
          available_languages: ["rust"],
          snapshots: null,
        }),
    });

    expect(result.ok).toBe(false);
  });
});
