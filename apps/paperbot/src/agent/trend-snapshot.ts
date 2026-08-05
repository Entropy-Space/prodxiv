import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
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

const MAX_SNAPSHOT_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_SNAPSHOT_BYTES = 256 * 1024;
const MAX_SOURCE_SCOPES = 100;
const MAX_ENTRIES_PER_SCOPE = 100;
const MAX_TOTAL_ENTRIES = 5_000;
const MAX_UNIQUE_CANDIDATES = 1_000;
const MAX_SCOPE_CHARACTERS = 100;

export const TREND_SNAPSHOT_SCHEMA_VERSION = "1";
export const DEFAULT_PRODXIV_API_URL = "https://prodxiv-api.vercel.app/";

export interface TrendSnapshotInputOptions {
  api_url?: string;
  snapshot_path?: string;
}

export interface TrendSnapshotDependencies {
  env?: Record<string, string | undefined>;
  fetch?: ApiFetch;
}

export interface TrendSnapshotBundle {
  schema_version: typeof TREND_SNAPSHOT_SCHEMA_VERSION;
  snapshot_date: string;
  period: "daily";
  language: "all" | "any";
  spoken_language: null;
  scopes: GitHubTrendingSnapshot[];
}

export interface TrendCandidateAppearance {
  scope_language: string;
  source_rank: number;
  stars_in_period?: number | null;
}

export interface TrendCandidate extends Omit<
  GitHubTrendingEntry,
  "rank" | "stars_in_period"
> {
  candidate_rank: number;
  source_appearances: TrendCandidateAppearance[];
}

export async function loadTrendSnapshot(
  options: TrendSnapshotInputOptions,
  snapshotDate: string,
  dependencies: TrendSnapshotDependencies,
): Promise<TrendSnapshotBundle> {
  if (options.snapshot_path !== undefined) {
    if (options.api_url !== undefined) {
      throw new PaperbotError(
        "agent select-trending accepts either --snapshot or --api-url, not both",
        ExitCode.usage,
      );
    }
    return normalizeSnapshotInput(
      await readSnapshotFile(options.snapshot_path),
      "snapshot file",
    );
  }

  const environmentApiUrl = (
    dependencies.env ?? process.env
  ).PRODXIV_API_URL?.trim();
  const apiUrl = normalizeApiUrl(
    options.api_url ??
      (environmentApiUrl === undefined || environmentApiUrl.length === 0
        ? DEFAULT_PRODXIV_API_URL
        : environmentApiUrl),
  );
  let snapshot: TrendSnapshotBundle | undefined;
  try {
    snapshot = await loadArchivedSnapshotBundle(
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
      `prodxiv has no daily GitHub Trending snapshots for ${snapshotDate}; retry after archive ingestion or use --snapshot <path>`,
      ExitCode.remote,
    );
  }
  if (snapshot.snapshot_date !== snapshotDate) {
    throw new PaperbotError(
      `prodxiv returned snapshot ${snapshot.snapshot_date} when ${snapshotDate} was requested`,
      ExitCode.remote,
    );
  }
  return snapshot;
}

export function createTrendCandidates(
  snapshot: TrendSnapshotBundle,
): TrendCandidate[] {
  const candidates: TrendCandidate[] = [];
  const candidatesByName = new Map<string, TrendCandidate>();

  for (const scope of snapshot.scopes) {
    for (const entry of scope.entries) {
      const key = entry.repository_full_name.toLowerCase();
      const appearance: TrendCandidateAppearance = {
        scope_language: scope.language,
        source_rank: entry.rank,
        ...(entry.stars_in_period === undefined
          ? {}
          : { stars_in_period: entry.stars_in_period }),
      };
      const existing = candidatesByName.get(key);
      if (existing !== undefined) {
        existing.source_appearances.push(appearance);
        continue;
      }

      const candidate: TrendCandidate = {
        candidate_rank: candidates.length + 1,
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
        source_appearances: [appearance],
      };
      candidates.push(candidate);
      candidatesByName.set(key, candidate);
    }
  }

  return candidates;
}

async function loadArchivedSnapshotBundle(
  input: {
    api_url: string;
    snapshot_date: string;
  },
  fetcher?: ApiFetch,
): Promise<TrendSnapshotBundle | undefined> {
  const client = new ProdxivApiClient({
    api_url: input.api_url,
    ...(fetcher === undefined ? {} : { fetch: fetcher }),
  });
  const view = await client.getGitHubTrending({
    date: input.snapshot_date,
    period: "daily",
    language: "all",
  });
  const firstSnapshot = view.snapshots[0];
  if (firstSnapshot === undefined) {
    return undefined;
  }

  return normalizeSnapshotBundle(
    {
      schema_version: TREND_SNAPSHOT_SCHEMA_VERSION,
      snapshot_date: firstSnapshot.snapshot_date,
      period: "daily",
      language: "all",
      spoken_language: null,
      scopes: view.snapshots,
    },
    "prodxiv archive",
    ExitCode.remote,
  );
}

async function readSnapshotFile(path: string): Promise<unknown> {
  const absolutePath = resolve(path);
  let serialized: string;
  try {
    const metadata = await lstat(absolutePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_SNAPSHOT_BUNDLE_BYTES
    ) {
      throw new Error(
        `snapshot must be a regular file no larger than ${MAX_SNAPSHOT_BUNDLE_BYTES} bytes`,
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

function normalizeSnapshotInput(
  value: unknown,
  source: string,
  exitCode: ExitCodeValue = ExitCode.validation,
): TrendSnapshotBundle {
  if (isRecord(value) && Object.hasOwn(value, "scopes")) {
    return normalizeSnapshotBundle(value, source, exitCode);
  }

  const snapshot = normalizeSourceSnapshot(value, source, exitCode);
  if (
    snapshot.period !== "daily" ||
    snapshot.language !== "any" ||
    snapshot.spoken_language != null
  ) {
    throw invalidSnapshot(
      `${source} must be an unfiltered daily snapshot with language any or a Paperbot snapshot bundle`,
      exitCode,
    );
  }
  return {
    schema_version: TREND_SNAPSHOT_SCHEMA_VERSION,
    snapshot_date: snapshot.snapshot_date,
    period: "daily",
    language: "any",
    spoken_language: null,
    scopes: [snapshot],
  };
}

function normalizeSnapshotBundle(
  value: unknown,
  source: string,
  exitCode: ExitCodeValue,
): TrendSnapshotBundle {
  if (!isRecord(value)) {
    throw invalidSnapshot(`${source} must be an object`, exitCode);
  }
  if (serializedBytes(value) > MAX_SNAPSHOT_BUNDLE_BYTES) {
    throw invalidSnapshot(
      `${source} exceeds the ${MAX_SNAPSHOT_BUNDLE_BYTES}-byte limit`,
      exitCode,
    );
  }
  if (value.schema_version !== TREND_SNAPSHOT_SCHEMA_VERSION) {
    throw invalidSnapshot(
      `${source} has an unsupported schema_version`,
      exitCode,
    );
  }
  if (!isDateString(value.snapshot_date)) {
    throw invalidSnapshot(`${source} has an invalid snapshot_date`, exitCode);
  }
  const language = value.language === undefined ? "all" : value.language;
  if (language !== "all" && language !== "any") {
    throw invalidSnapshot(`${source} language must be all or any`, exitCode);
  }
  if (value.period !== "daily" || value.spoken_language != null) {
    throw invalidSnapshot(
      `${source} must contain daily scopes without a spoken-language filter`,
      exitCode,
    );
  }
  if (
    !Array.isArray(value.scopes) ||
    value.scopes.length === 0 ||
    value.scopes.length > MAX_SOURCE_SCOPES
  ) {
    throw invalidSnapshot(
      `${source} must contain from 1 to ${MAX_SOURCE_SCOPES} scopes`,
      exitCode,
    );
  }

  const scopes = value.scopes.map((scope, index) =>
    normalizeSourceSnapshot(scope, `${source} scope ${index + 1}`, exitCode),
  );
  const scopeNames = new Set<string>();
  let totalEntries = 0;
  let hasAnyLanguageScope = false;
  for (const scope of scopes) {
    if (
      scope.snapshot_date !== value.snapshot_date ||
      scope.period !== "daily" ||
      scope.spoken_language != null
    ) {
      throw invalidSnapshot(
        `${source} scopes must share snapshot_date, daily period, and no spoken-language filter`,
        exitCode,
      );
    }
    const scopeLanguage = scope.language;
    const key = scopeLanguage.toLowerCase();
    if (scopeNames.has(key)) {
      throw invalidSnapshot(
        `${source} contains duplicate language scopes`,
        exitCode,
      );
    }
    scopeNames.add(key);
    hasAnyLanguageScope ||= scopeLanguage === "any";
    totalEntries += scope.entries.length;
  }
  if (!hasAnyLanguageScope) {
    throw invalidSnapshot(
      `${source} is missing the unfiltered any scope`,
      exitCode,
    );
  }
  if (
    language === "any" &&
    (scopes.length !== 1 || scopes[0]?.language !== "any")
  ) {
    throw invalidSnapshot(
      `${source} with language any must contain only the unfiltered any scope`,
      exitCode,
    );
  }
  if (totalEntries > MAX_TOTAL_ENTRIES) {
    throw invalidSnapshot(
      `${source} contains more than ${MAX_TOTAL_ENTRIES} total entries`,
      exitCode,
    );
  }

  scopes.sort(compareScopes);
  const normalized: TrendSnapshotBundle = {
    schema_version: TREND_SNAPSHOT_SCHEMA_VERSION,
    snapshot_date: value.snapshot_date,
    period: "daily",
    language,
    spoken_language: null,
    scopes,
  };
  const candidateCount = createTrendCandidates(normalized).length;
  if (candidateCount > MAX_UNIQUE_CANDIDATES) {
    throw invalidSnapshot(
      `${source} contains more than ${MAX_UNIQUE_CANDIDATES} unique candidates`,
      exitCode,
    );
  }
  return normalized;
}

function normalizeSourceSnapshot(
  value: unknown,
  source: string,
  exitCode: ExitCodeValue,
): GitHubTrendingSnapshot {
  if (!isSnapshotContract(value)) {
    throw invalidSnapshot(
      `${source} does not match the prodxiv snapshot contract`,
      exitCode,
    );
  }
  if (serializedBytes(value) > MAX_SOURCE_SNAPSHOT_BYTES) {
    throw invalidSnapshot(
      `${source} exceeds the ${MAX_SOURCE_SNAPSHOT_BYTES}-byte per-scope limit`,
      exitCode,
    );
  }
  if (value.entries.length > MAX_ENTRIES_PER_SCOPE) {
    throw invalidSnapshot(
      `${source} contains more than ${MAX_ENTRIES_PER_SCOPE} entries`,
      exitCode,
    );
  }

  const names = new Set<string>();
  const entries = value.entries.map((entry, index) => {
    const expectedRank = index + 1;
    if (entry.rank !== expectedRank) {
      throw invalidSnapshot(
        `${source} entry ${expectedRank} has non-sequential rank ${entry.rank}`,
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
        `${source} entry ${expectedRank} has an invalid repository_full_name`,
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
        `${source} entry ${expectedRank} has a non-canonical repository_url`,
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
    language: value.language ?? "any",
    spoken_language: value.spoken_language ?? null,
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

function normalizeApiUrl(value: string): string {
  if (value.length === 0) {
    throw new PaperbotError(
      "prodxiv API URL must not be empty",
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

type SnapshotInputContract = Omit<GitHubTrendingSnapshot, "language"> & {
  language?: string | null;
};

function isSnapshotContract(value: unknown): value is SnapshotInputContract {
  return (
    isRecord(value) &&
    isDateString(value.snapshot_date) &&
    isOptionalString(value.captured_at) &&
    (value.period === "daily" ||
      value.period === "weekly" ||
      value.period === "monthly") &&
    isOptionalScope(value.language) &&
    value.language !== "all" &&
    isOptionalScope(value.spoken_language) &&
    isNonEmptyString(value.source_kind) &&
    isNonEmptyString(value.source_url) &&
    isNonEmptyString(value.source_revision) &&
    Array.isArray(value.entries) &&
    value.entries.every(isEntryContract)
  );
}

function isEntryContract(value: unknown): value is GitHubTrendingEntry {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.rank) &&
    (value.rank as number) > 0 &&
    isNonEmptyString(value.repository_full_name) &&
    isOptionalString(value.repository_node_id) &&
    isNonEmptyString(value.repository_url) &&
    isOptionalString(value.description) &&
    isOptionalString(value.primary_language) &&
    isOptionalNonNegativeInteger(value.stars) &&
    isOptionalNonNegativeInteger(value.forks) &&
    isOptionalNonNegativeInteger(value.stars_in_period)
  );
}

function isDateString(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.valueOf()) &&
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalScope(value: unknown): value is string | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_SCOPE_CHARACTERS &&
      value === value.trim() &&
      !/[\u0000-\u001f\u007f]/.test(value))
  );
}

function isOptionalNonNegativeInteger(
  value: unknown,
): value is number | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (Number.isSafeInteger(value) && (value as number) >= 0)
  );
}

function compareScopes(
  left: GitHubTrendingSnapshot,
  right: GitHubTrendingSnapshot,
): number {
  if (left.language === "any") {
    return right.language === "any" ? 0 : -1;
  }
  if (right.language === "any") {
    return 1;
  }
  return compareStrings(left.language, right.language);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
