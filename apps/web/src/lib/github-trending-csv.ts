import type { GitHubTrendingSnapshot } from "@prodxiv/api-client";

const columns = [
  "snapshot_date",
  "period",
  "scope_language",
  "scope_spoken_language",
  "rank",
  "repository_full_name",
  "repository_node_id",
  "repository_url",
  "description",
  "primary_language",
  "stars",
  "forks",
  "stars_in_period",
  "captured_at",
  "source_kind",
  "source_url",
  "source_revision",
] as const;

type CsvValue = number | string | null | undefined;

export function buildGitHubTrendingCsv(
  snapshots: GitHubTrendingSnapshot[],
): string {
  const rows: CsvValue[][] = [columns.slice()];

  for (const snapshot of snapshots) {
    for (const entry of snapshot.entries) {
      rows.push([
        snapshot.snapshot_date,
        snapshot.period,
        snapshot.language ?? "all",
        snapshot.spoken_language,
        entry.rank,
        entry.repository_full_name,
        entry.repository_node_id,
        entry.repository_url,
        entry.description,
        entry.primary_language,
        entry.stars,
        entry.forks,
        entry.stars_in_period,
        snapshot.captured_at,
        snapshot.source_kind,
        snapshot.source_url,
        snapshot.source_revision,
      ]);
    }
  }

  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function githubTrendingCsvFilename(
  date: string,
  period: "daily" | "weekly" | "monthly",
): string {
  return `github-trending-${date}-${period}-all-scopes.csv`;
}

function csvCell(value: CsvValue): string {
  const serialized = value === null || value === undefined ? "" : String(value);
  const spreadsheetSafe = /^[\t\r\n ]*[=+\-@]/.test(serialized)
    ? `'${serialized}`
    : serialized;
  return `"${spreadsheetSafe.replaceAll('"', '""')}"`;
}
