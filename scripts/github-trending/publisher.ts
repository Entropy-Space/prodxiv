import type { TrendingSnapshot } from "./collector.ts";

export interface IngestionConfig {
  api_url: string;
  ingest_token: string;
}

export interface IngestionFailure {
  language: string | null;
  message: string;
}

export interface IngestionResult {
  published_count: number;
  failures: IngestionFailure[];
}

interface IngestionResponse {
  snapshot_id: number;
  entry_count: number;
  inserted: boolean;
}

class IngestionRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export function readIngestionConfig(
  environment: Record<string, string | undefined> = process.env,
): IngestionConfig {
  const api_url = environment.PRODXIV_API_URL?.replace(/\/+$/, "");
  if (api_url === undefined || api_url.length === 0) {
    throw new Error("PRODXIV_API_URL is required");
  }
  const parsed = new URL(api_url);
  const local =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error("PRODXIV_API_URL must use HTTPS except on localhost");
  }

  const ingest_token = environment.PRODXIV_TRENDING_INGEST_TOKEN;
  if (ingest_token === undefined || ingest_token.length < 32) {
    throw new Error(
      "PRODXIV_TRENDING_INGEST_TOKEN must contain at least 32 characters",
    );
  }
  return { api_url, ingest_token };
}

export async function publishTrendingSnapshots(
  snapshots: TrendingSnapshot[],
  config: IngestionConfig,
  fetcher: typeof fetch = fetch,
): Promise<IngestionResult> {
  let published_count = 0;
  const failures: IngestionFailure[] = [];

  for (const snapshot of snapshots) {
    try {
      const response = await publishSnapshot(snapshot, config, fetcher);
      published_count += 1;
      console.log(
        `${snapshot.language ?? "all"}: ${response.inserted ? "ingested" : "already present"} snapshot ${response.snapshot_id}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${snapshot.language ?? "all"}: ${message}`);
      failures.push({ language: snapshot.language, message });
    }
  }

  return { published_count, failures };
}

export function snapshotIdempotencyKey(snapshot: TrendingSnapshot): string {
  const scope = snapshot.language
    ?.replaceAll("#", "-sharp")
    .replaceAll("+", "-plus");
  const revision = snapshot.source_revision.replace(/^sha256:/, "");
  const key = `github-trending:${snapshot.snapshot_date}:${scope ?? "all"}:${revision}`;
  if (key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new Error("snapshot cannot produce a valid idempotency key");
  }
  return key;
}

async function publishSnapshot(
  snapshot: TrendingSnapshot,
  config: IngestionConfig,
  fetcher: typeof fetch,
): Promise<IngestionResponse> {
  const endpoint = `${config.api_url}/v1/github/trending/snapshots`;
  let last_error: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.ingest_token}`,
          "content-type": "application/json",
          "idempotency-key": snapshotIdempotencyKey(snapshot),
          "user-agent": "prodxiv-trending-collector/0.1 (+https://prodxiv.com)",
        },
        body: JSON.stringify(snapshot),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 200 || response.status === 201) {
        return parseIngestionResponse(await response.json());
      }

      const message = await apiErrorMessage(response);
      throw new IngestionRequestError(message, response.status >= 500);
    } catch (error) {
      if (error instanceof IngestionRequestError && !error.retryable) {
        throw error;
      }
      last_error = error;
      if (attempt === 3) {
        break;
      }
    }
    await Bun.sleep(attempt * 2_000);
  }

  throw last_error;
}

function parseIngestionResponse(value: unknown): IngestionResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    !("snapshot_id" in value) ||
    !("entry_count" in value) ||
    !("inserted" in value) ||
    typeof value.snapshot_id !== "number" ||
    typeof value.entry_count !== "number" ||
    !Number.isSafeInteger(value.snapshot_id) ||
    !Number.isSafeInteger(value.entry_count) ||
    typeof value.inserted !== "boolean"
  ) {
    throw new Error("ingestion API returned an invalid response");
  }
  return {
    snapshot_id: value.snapshot_id,
    entry_count: value.entry_count,
    inserted: value.inserted,
  };
}

async function apiErrorMessage(response: Response): Promise<string> {
  const fallback = `ingestion API returned HTTP ${response.status}`;
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "message" in body.error &&
      typeof body.error.message === "string"
    ) {
      return `${fallback}: ${body.error.message}`;
    }
  } catch {
    // The status remains sufficient when the response is not JSON.
  }
  return fallback;
}
