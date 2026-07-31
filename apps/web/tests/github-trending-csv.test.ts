import { describe, expect, test } from "bun:test";

import {
  buildGitHubTrendingCsv,
  githubTrendingCsvFilename,
} from "../src/lib/github-trending-csv.ts";

describe("buildGitHubTrendingCsv", () => {
  test("exports scope, repository metrics, and provenance", () => {
    const csv = buildGitHubTrendingCsv([
      {
        snapshot_date: "2026-07-29",
        captured_at: "2026-07-29T02:17:00Z",
        period: "daily",
        language: "rust",
        spoken_language: null,
        source_kind: "github_trending",
        source_url: "https://github.com/trending/rust?since=daily",
        source_revision: "abc123",
        entries: [
          {
            rank: 1,
            repository_full_name: "example/project",
            repository_node_id: "R_123",
            repository_url: "https://github.com/example/project",
            description: 'A "quoted", useful project',
            primary_language: "Rust",
            stars: 1200,
            forks: 75,
            stars_in_period: 42,
          },
        ],
      },
    ]);

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"scope_language"');
    expect(csv).toContain('"rust","","1","example/project"');
    expect(csv).toContain('"A ""quoted"", useful project"');
    expect(csv).toContain('"1200","75","42"');
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  test("neutralizes spreadsheet formulas in repository text", () => {
    const csv = buildGitHubTrendingCsv([
      {
        snapshot_date: "2026-07-29",
        captured_at: null,
        period: "daily",
        language: null,
        spoken_language: null,
        source_kind: "github_trending",
        source_url: "https://github.com/trending",
        source_revision: "abc123",
        entries: [
          {
            rank: 1,
            repository_full_name: "=malicious/formula",
            repository_node_id: null,
            repository_url: "https://github.com/malicious/formula",
            description: "+SUM(1,1)",
            primary_language: null,
            stars: null,
            forks: null,
            stars_in_period: null,
          },
        ],
      },
    ]);

    expect(csv).toContain('"\'=malicious/formula"');
    expect(csv).toContain('"\'+SUM(1,1)"');
  });
});

test("githubTrendingCsvFilename names the selected day and period", () => {
  expect(githubTrendingCsvFilename("2026-07-29", "daily")).toBe(
    "github-trending-2026-07-29-daily-all-scopes.csv",
  );
});
