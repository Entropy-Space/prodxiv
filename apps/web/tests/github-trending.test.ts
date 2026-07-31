import { describe, expect, test } from "bun:test";

import {
  readGitHubTrending,
  readGitHubTrendingDay,
} from "../src/lib/github-trending.ts";

describe("readGitHubTrending", () => {
  test("returns the latest imported snapshot", async () => {
    const result = await readGitHubTrending({
      api_url: "https://api.prodxiv.example",
      period: "daily",
      fetch: async () =>
        Response.json({
          previous_date: "2026-07-28",
          next_date: "2026-07-30",
          available_languages: ["rust", "typescript"],
          snapshot: {
            snapshot_date: "2026-07-29",
            captured_at: null,
            period: "daily",
            language: null,
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
        }),
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.view.snapshot?.entries[0]?.rank).toBe(1);
    expect(result.ok && result.view.next_date).toBe("2026-07-30");
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
        const language = new URL(url).searchParams.get("language");
        return Response.json({
          previous_date: null,
          next_date: null,
          available_languages: language === null ? ["rust", "typescript"] : [],
          snapshot: {
            snapshot_date: "2026-07-29",
            captured_at: null,
            period: "daily",
            language,
            spoken_language: null,
            source_kind: "github_trending",
            source_url: "https://github.com/trending",
            source_revision: `revision-${language ?? "all"}`,
            entries: [],
          },
        });
      },
    });

    expect(
      result.ok && result.snapshots.map((snapshot) => snapshot.language),
    ).toEqual([null, "rust", "typescript"]);
    expect(requestedUrls).toHaveLength(3);
  });

  test("fails the complete export when one scope cannot be loaded", async () => {
    const result = await readGitHubTrendingDay({
      api_url: "https://api.prodxiv.example",
      date: "2026-07-29",
      fetch: async (input) => {
        const language = new URL(String(input)).searchParams.get("language");
        if (language === "rust") {
          throw new Error("scope unavailable");
        }
        return Response.json({
          previous_date: null,
          next_date: null,
          available_languages: ["rust"],
          snapshot: null,
        });
      },
    });

    expect(result).toEqual({
      ok: false,
      message: "GitHub Trending observations could not be loaded.",
    });
  });

  test("does not silently omit an advertised scope", async () => {
    const result = await readGitHubTrendingDay({
      api_url: "https://api.prodxiv.example",
      date: "2026-07-29",
      fetch: async (input) => {
        const language = new URL(String(input)).searchParams.get("language");
        return Response.json({
          previous_date: null,
          next_date: null,
          available_languages: language === null ? ["rust"] : [],
          snapshot: null,
        });
      },
    });

    expect(result.ok).toBe(false);
  });
});
