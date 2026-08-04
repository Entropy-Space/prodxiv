import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  isGitHubTrendingSnapshot,
  ProdxivApiClient,
  ProdxivApiError,
  type ApiFetch,
  type GitHubTrendingEntry,
  type GitHubTrendingSnapshot,
} from "@prodxiv/api-client";
import {
  ExitCode,
  PaperbotError,
  type ExitCode as ExitCodeValue,
} from "@prodxiv/paperbot-core";

const MAX_SNAPSHOT_BYTES = 256 * 1024;
const MAX_SNAPSHOT_ENTRIES = 100;

export interface TrendSnapshotInputOptions {
  api_url?: string;
  snapshot_path?: string;
}

export interface TrendSnapshotDependencies {
  env?: Record<string, string | undefined>;
  fetch?: ApiFetch;
}

export async function loadTrendSnapshot(
  options: TrendSnapshotInputOptions,
  snapshotDate: string,
  dependencies: TrendSnapshotDependencies,
): Promise<GitHubTrendingSnapshot> {
  if (options.snapshot_path !== undefined) {
    if (options.api_url !== undefined) {
      throw new PaperbotError(
        "agent select-trending accepts either --snapshot or --api-url, not both",
        ExitCode.usage,
      );
    }
    return normalizeSnapshot(
      await readSnapshotFile(options.snapshot_path),
      "snapshot file",
    );
  }

  const apiUrl = normalizeApiUrl(
    options.api_url ??
      (dependencies.env ?? process.env).PRODXIV_API_URL?.trim(),
  );
  let snapshot: GitHubTrendingSnapshot | undefined;
  try {
    snapshot = await loadArchivedSnapshot(
      {
        api_url: apiUrl,
        snapshot_date: snapshotDate,
      },
      dependencies.fetch,
    );
  } catch (error) {
    const exitCode =
      error instanceof ProdxivApiError && error.status === 0
        ? ExitCode.network
        : ExitCode.remote;
    throw new PaperbotError(
      `could not load the prodxiv GitHub Trending archive: ${safeMessage(error)}`,
      exitCode,
    );
  }
  if (snapshot === undefined) {
    throw new PaperbotError(
      `prodxiv has no all-language daily GitHub Trending snapshot for ${snapshotDate}; retry after archive ingestion or use --snapshot <path>`,
      ExitCode.remote,
    );
  }
  const normalized = normalizeSnapshot(
    snapshot,
    "prodxiv archive",
    ExitCode.remote,
  );
  if (normalized.snapshot_date !== snapshotDate) {
    throw new PaperbotError(
      `prodxiv returned snapshot ${normalized.snapshot_date} when ${snapshotDate} was requested`,
      ExitCode.remote,
    );
  }
  return normalized;
}

async function loadArchivedSnapshot(
  input: {
    api_url: string;
    snapshot_date: string;
  },
  fetcher?: ApiFetch,
): Promise<GitHubTrendingSnapshot | undefined> {
  const client = new ProdxivApiClient({
    api_url: input.api_url,
    ...(fetcher === undefined ? {} : { fetch: fetcher }),
  });
  const view = await client.getGitHubTrending({
    date: input.snapshot_date,
    period: "daily",
  });
  return view.snapshot;
}

async function readSnapshotFile(path: string): Promise<unknown> {
  const absolutePath = resolve(path);
  let serialized: string;
  try {
    const metadata = await lstat(absolutePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_SNAPSHOT_BYTES
    ) {
      throw new Error(
        `snapshot must be a regular file no larger than ${MAX_SNAPSHOT_BYTES} bytes`,
      );
    }
    serialized = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new PaperbotError(
      `could not read trend snapshot ${path}: ${safeMessage(error)}`,
      ExitCode.io,
    );
  }
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new PaperbotError(
      `trend snapshot is not valid JSON: ${path}`,
      ExitCode.validation,
    );
  }
}

function normalizeSnapshot(
  value: unknown,
  source: string,
  exitCode: ExitCodeValue = ExitCode.validation,
): GitHubTrendingSnapshot {
  if (!isGitHubTrendingSnapshot(value)) {
    throw invalidSnapshot(
      `${source} does not match the prodxiv snapshot contract`,
      exitCode,
    );
  }
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    MAX_SNAPSHOT_BYTES
  ) {
    throw invalidSnapshot(
      `${source} exceeds the ${MAX_SNAPSHOT_BYTES}-byte limit`,
      exitCode,
    );
  }
  if (
    value.period !== "daily" ||
    value.language != null ||
    value.spoken_language != null
  ) {
    throw invalidSnapshot(
      `${source} must be an all-language daily snapshot`,
      exitCode,
    );
  }
  if (value.entries.length > MAX_SNAPSHOT_ENTRIES) {
    throw invalidSnapshot(
      `${source} contains more than ${MAX_SNAPSHOT_ENTRIES} candidates`,
      exitCode,
    );
  }

  const names = new Set<string>();
  const entries = value.entries.map((entry, index) => {
    const expectedRank = index + 1;
    if (entry.rank !== expectedRank) {
      throw invalidSnapshot(
        `${source} candidate ${expectedRank} has non-sequential rank ${entry.rank}`,
        exitCode,
      );
    }
    const parts = entry.repository_full_name.split("/");
    if (
      parts.length !== 2 ||
      parts.some(
        (part) =>
          part.length === 0 ||
          part.length > 100 ||
          /[\s\u0000-\u001f\u007f]/.test(part),
      )
    ) {
      throw invalidSnapshot(
        `${source} candidate ${expectedRank} has an invalid repository_full_name`,
        exitCode,
      );
    }
    const key = entry.repository_full_name.toLowerCase();
    if (names.has(key)) {
      throw invalidSnapshot(
        `${source} contains duplicate repository names`,
        exitCode,
      );
    }
    names.add(key);
    const expectedUrl = `https://github.com/${entry.repository_full_name}`;
    if (entry.repository_url !== expectedUrl) {
      throw invalidSnapshot(
        `${source} candidate ${expectedRank} has a non-canonical repository_url`,
        exitCode,
      );
    }
    return normalizeEntry(entry);
  });

  return {
    snapshot_date: value.snapshot_date,
    ...(value.captured_at === undefined
      ? {}
      : { captured_at: value.captured_at }),
    period: value.period,
    ...(value.language === undefined ? {} : { language: value.language }),
    ...(value.spoken_language === undefined
      ? {}
      : { spoken_language: value.spoken_language }),
    source_kind: value.source_kind,
    source_url: value.source_url,
    source_revision: value.source_revision,
    entries,
  };
}

function normalizeEntry(entry: GitHubTrendingEntry): GitHubTrendingEntry {
  return {
    rank: entry.rank,
    repository_full_name: entry.repository_full_name,
    ...(entry.repository_node_id === undefined
      ? {}
      : { repository_node_id: entry.repository_node_id }),
    repository_url: entry.repository_url,
    ...(entry.description === undefined
      ? {}
      : { description: entry.description }),
    ...(entry.primary_language === undefined
      ? {}
      : { primary_language: entry.primary_language }),
    ...(entry.stars === undefined ? {} : { stars: entry.stars }),
    ...(entry.forks === undefined ? {} : { forks: entry.forks }),
    ...(entry.stars_in_period === undefined
      ? {}
      : { stars_in_period: entry.stars_in_period }),
  };
}

function normalizeApiUrl(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new PaperbotError(
      "prodxiv API is not configured; pass --api-url, set PRODXIV_API_URL, or use --snapshot <path>",
      ExitCode.usage,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PaperbotError(
      `prodxiv API URL is invalid: ${value}`,
      ExitCode.usage,
    );
  }
  const isLocal =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new PaperbotError(
      "prodxiv API URL must use HTTPS, except for localhost",
      ExitCode.usage,
    );
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new PaperbotError(
      "prodxiv API URL must not contain credentials, a query, or a fragment",
      ExitCode.usage,
    );
  }
  return url.toString().replace(/\/+$/, "");
}

function invalidSnapshot(
  message: string,
  exitCode: ExitCodeValue,
): PaperbotError {
  return new PaperbotError(`invalid trend snapshot: ${message}`, exitCode);
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
