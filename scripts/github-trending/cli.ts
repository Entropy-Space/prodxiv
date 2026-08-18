import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveApiBearerToken } from "../github-actions/oidc.ts";
import {
  ALL_LANGUAGES,
  ANY_LANGUAGE,
  collectTrendingSnapshots,
  defaultLanguages,
  snapshotFileName,
  type TrendingSnapshot,
} from "./collector.ts";
import {
  publishTrendingSnapshots,
  readIngestionConfig,
  type IngestionConfig,
} from "./publisher.ts";

interface Arguments {
  snapshot_date: string;
  captured_at: string;
  languages: string[];
  output_dir: string | null;
}

export async function runCollector(
  arguments_: Arguments,
  loadIngestionConfig: () => Promise<IngestionConfig>,
): Promise<void> {
  const collected = await collectTrendingSnapshots(arguments_);
  if (arguments_.output_dir !== null) {
    await writeSnapshots(arguments_.output_dir, collected.snapshots);
  }
  if (collected.snapshots.length === 0) {
    throw new Error("no valid GitHub Trending snapshots were collected");
  }
  const ingestion_config = await loadIngestionConfig();

  const ingested = await publishTrendingSnapshots(
    collected.snapshots,
    ingestion_config,
  );
  const failures = [...collected.failures, ...ingested.failures];
  if (failures.length > 0) {
    throw new Error(
      `failed to process ${failures.length} scope(s): ${failures
        .map(({ language }) => language)
        .join(", ")}`,
    );
  }
}

export function parseArguments(values: string[]): Arguments {
  let snapshot_date: string | null = null;
  let captured_at: string | null = null;
  let output_dir: string | null = null;
  const requestedLanguages: string[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    switch (argument) {
      case "--snapshot-date":
        snapshot_date = requiredValue(values, ++index, argument);
        break;
      case "--captured-at":
        captured_at = requiredValue(values, ++index, argument);
        break;
      case "--output-dir":
        output_dir = requiredValue(values, ++index, argument);
        break;
      case "--language": {
        const language = requiredValue(values, ++index, argument).toLowerCase();
        if (!/^[a-z0-9#+.-]+$/.test(language)) {
          throw new Error(`invalid language slug: ${language}`);
        }
        requestedLanguages.push(language);
        break;
      }
      default:
        throw new Error(`unknown argument: ${argument}\n\n${usage()}`);
    }
  }

  if (snapshot_date === null || !isSnapshotDate(snapshot_date)) {
    throw new Error("--snapshot-date must use a real YYYY-MM-DD date");
  }
  if (captured_at === null || !isCapturedAt(captured_at)) {
    throw new Error("--captured-at must use YYYY-MM-DDTHH:MM:SSZ in UTC");
  }
  if (captured_at.slice(0, 10) !== snapshot_date) {
    throw new Error("--snapshot-date must match the UTC date in --captured-at");
  }
  if (
    requestedLanguages.includes(ALL_LANGUAGES) &&
    requestedLanguages.length !== 1
  ) {
    throw new Error(
      "--language all cannot be combined with other language scopes",
    );
  }
  if (new Set(requestedLanguages).size !== requestedLanguages.length) {
    throw new Error("language scopes must not be repeated");
  }

  const languages =
    requestedLanguages.length === 0 || requestedLanguages[0] === ALL_LANGUAGES
      ? [ANY_LANGUAGE, ...defaultLanguages]
      : requestedLanguages;

  return { snapshot_date, captured_at, languages, output_dir };
}

function requiredValue(
  values: string[],
  index: number,
  argument: string,
): string {
  const value = values[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${argument} requires a value`);
  }
  return value;
}

function isSnapshotDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

function isCapturedAt(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    return false;
  }

  const timestamp = Date.parse(value);
  return (
    !Number.isNaN(timestamp) &&
    new Date(timestamp).toISOString().replace(".000Z", "Z") === value
  );
}

async function writeSnapshots(
  output_dir: string,
  snapshots: TrendingSnapshot[],
): Promise<void> {
  await mkdir(output_dir, { recursive: true });
  for (const snapshot of snapshots) {
    const path = join(output_dir, snapshotFileName(snapshot.language));
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
}

function usage(): string {
  return [
    "usage: bun run collect:github-trending --",
    "  --snapshot-date YYYY-MM-DD",
    "  --captured-at YYYY-MM-DDTHH:MM:SSZ",
    "  [--language all | --language any | --language rust ...]",
    "  [--output-dir path]",
  ].join(" \\\n");
}

if (import.meta.main) {
  try {
    await runCollector(parseArguments(Bun.argv.slice(2)), async () =>
      readIngestionConfig(
        process.env,
        await resolveApiBearerToken("PRODXIV_TRENDING_INGEST_TOKEN"),
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
