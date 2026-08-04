import { load } from "cheerio";

export const defaultLanguages = [
  "c#",
  "c++",
  "dart",
  "elixir",
  "go",
  "java",
  "javascript",
  "julia",
  "kotlin",
  "markdown",
  "php",
  "python",
  "raku",
  "rust",
  "scala",
  "shell",
  "swift",
  "typescript",
  "vue",
  "zig",
] as const;

export interface TrendingEntry {
  repository_full_name: string;
  repository_node_id: string | null;
  description: string | null;
  primary_language: string | null;
  stars: number;
  forks: number;
  stars_in_period: number;
}

export interface TrendingSnapshot {
  snapshot_date: string;
  captured_at: string;
  period: "daily";
  language: string | null;
  spoken_language: null;
  source_kind: "direct_fetch";
  source_url: string;
  source_revision: string;
  entries: TrendingEntry[];
}

export interface CollectionOptions {
  snapshot_date: string;
  captured_at: string;
  languages: Array<string | null>;
}

export interface CollectionFailure {
  language: string | null;
  message: string;
}

export interface CollectionResult {
  snapshots: TrendingSnapshot[];
  failures: CollectionFailure[];
}

export class TrendingParseError extends Error {}

export function trendingUrl(language: string | null): string {
  const path = language === null ? "" : `/${encodeURIComponent(language)}`;
  return `https://github.com/trending${path}?since=daily`;
}

export function snapshotFileName(language: string | null): string {
  if (language === null) {
    return "all.json";
  }
  return `${language
    .replaceAll("#", "-sharp")
    .replaceAll("+", "-plus")
    .replace(/[^a-z0-9-]+/g, "-")}.json`;
}

export function parseTrendingHtml(source: string): TrendingEntry[] {
  const $ = load(source);
  const result = $("div[data-hpc]").first();
  if (result.length === 0) {
    throw new TrendingParseError("GitHub Trending result container is missing");
  }

  return result
    .find("article.Box-row")
    .toArray()
    .map((article) => {
      const row = $(article);
      const href = row.find("h2 a[href]").first().attr("href");
      const repository_full_name = repositoryNameFromHref(href);
      if (repository_full_name === null) {
        throw new TrendingParseError(
          "trending repository is missing a valid owner/name link",
        );
      }

      const description = optionalText(row.find("p.col-9").first().text());
      const primary_language = optionalText(
        row.find('[itemprop="programmingLanguage"]').first().text(),
      );
      const stars = parseFormattedCount(
        row.find('a[href$="/stargazers"]').first().text(),
        repository_full_name,
        "stars",
      );
      const forks = parseFormattedCount(
        row.find('a[href$="/forks"]').first().text(),
        repository_full_name,
        "forks",
      );
      const stars_in_period = parseDailyStars(
        row.find("span.float-sm-right").first().text(),
        repository_full_name,
      );

      return {
        repository_full_name,
        repository_node_id: null,
        description,
        primary_language,
        stars,
        forks,
        stars_in_period,
      };
    });
}

export async function collectTrendingSnapshots(
  options: CollectionOptions,
  fetcher: typeof fetch = fetch,
): Promise<CollectionResult> {
  const snapshots: TrendingSnapshot[] = [];
  const failures: CollectionFailure[] = [];

  for (const language of options.languages) {
    const source_url = trendingUrl(language);
    try {
      const source = await fetchWithRetries(source_url, fetcher);
      const entries = parseTrendingHtml(source);
      const source_revision = `sha256:${new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(entries))
        .digest("hex")}`;
      snapshots.push({
        snapshot_date: options.snapshot_date,
        captured_at: options.captured_at,
        period: "daily",
        language,
        spoken_language: null,
        source_kind: "direct_fetch",
        source_url,
        source_revision,
        entries,
      });
      console.log(`${language ?? "all"}: captured ${entries.length} entries`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${language ?? "all"}: ${message}`);
      failures.push({ language, message });
    }
  }

  return { snapshots, failures };
}

async function fetchWithRetries(
  source_url: string,
  fetcher: typeof fetch,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetcher(source_url, {
        headers: {
          "user-agent": "prodxiv-trending-collector/0.1 (+https://prodxiv.com)",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`GitHub returned HTTP ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await Bun.sleep(attempt * 2_000);
      }
    }
  }
  throw lastError;
}

function repositoryNameFromHref(href: string | undefined): string | null {
  if (href === undefined) {
    return null;
  }
  const parts = href.split("/").filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }
  const [owner, repository] = parts;
  if (owner === undefined || repository === undefined) {
    return null;
  }
  return `${owner}/${repository}`;
}

function optionalText(value: string): string | null {
  const normalized = normalizeText(value);
  return normalized.length === 0 ? null : normalized;
}

function parseFormattedCount(
  value: string,
  repository: string,
  field: string,
): number {
  const normalized = normalizeText(value);
  if (!/^[\d,]+$/.test(normalized)) {
    throw new TrendingParseError(
      `trending repository ${repository} has an invalid ${field}: ${normalized || "(missing)"}`,
    );
  }
  const count = Number(normalized.replaceAll(",", ""));
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TrendingParseError(
      `trending repository ${repository} has an invalid ${field}: ${normalized}`,
    );
  }
  return count;
}

function parseDailyStars(value: string, repository: string): number {
  const normalized = normalizeText(value);
  const match = /^([\d,]+) stars? today$/.exec(normalized);
  if (match?.[1] === undefined) {
    throw new TrendingParseError(
      `trending repository ${repository} has an unexpected period label: ${normalized || "(missing)"}`,
    );
  }
  return parseFormattedCount(match[1], repository, "daily stars");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
