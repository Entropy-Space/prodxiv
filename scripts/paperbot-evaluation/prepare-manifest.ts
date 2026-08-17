import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  ProdxivApiClient,
  type PaperDraft,
  type PublishedPaperSummary,
} from "../../packages/api-client/src/client.ts";
import { PAPERBOT_VERSION } from "../../apps/paperbot/src/version.ts";

const DISCOVERY_COUNT = 3;

export interface EvaluationProject {
  repository_url: string;
  ref?: string;
}

export interface EvaluationManifest {
  schema_version: "1";
  projects: EvaluationProject[];
}

interface TrendSelection {
  selected_repositories: Array<{
    repository_full_name: string;
  }>;
}

export async function prepareEvaluationManifest(
  selectionPath: string,
  excludedRepositories: ReadonlySet<string> = new Set(),
): Promise<EvaluationManifest> {
  const selection = parseSelection(
    await readJson(selectionPath),
    selectionPath,
  );
  const discovery = selection.selected_repositories
    .map((project) => project.repository_full_name.toLowerCase())
    .filter((name) => !excludedRepositories.has(name))
    .slice(0, DISCOVERY_COUNT)
    .map((name) => ({
      repository_url: `https://github.com/${name}`,
    }));
  if (discovery.length !== DISCOVERY_COUNT) {
    throw new Error(
      `daily Paperbot selection did not provide ${DISCOVERY_COUNT} repositories without a current-version paper`,
    );
  }
  return {
    schema_version: "1",
    projects: discovery,
  };
}

async function main(): Promise<void> {
  const [selectionPath, outputPath] = process.argv.slice(2);
  if (selectionPath === undefined || outputPath === undefined) {
    throw new Error(
      "usage: prepare-manifest.ts <selection.json> <output.json>",
    );
  }
  const excludedRepositories = await currentPaperbotRepositories(
    process.env.PRODXIV_API_URL,
    process.env.PRODXIV_BOT_TOKEN,
  );
  const manifest = await prepareEvaluationManifest(
    resolve(selectionPath),
    excludedRepositories,
  );
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

async function currentPaperbotRepositories(
  apiUrlValue: string | undefined,
  token: string | undefined,
): Promise<Set<string>> {
  if (apiUrlValue === undefined || token === undefined) {
    throw new Error(
      "PRODXIV_API_URL and PRODXIV_BOT_TOKEN are required to exclude existing Paperbot papers",
    );
  }
  const client = new ProdxivApiClient({
    api_url: configuredApiUrl(apiUrlValue),
    token,
  });
  const repositories = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const page = await client.listPapers({ limit: 100, cursor });
    for (const paper of page.papers) {
      addCurrentPaperbotRepository(repositories, paper);
    }
    cursor = page.next_cursor;
    if (cursor === undefined) {
      break;
    }
    if (pageIndex === 99) {
      throw new Error("published paper pagination did not converge");
    }
  }

  const draftLists = await Promise.all([
    client.listDrafts({ limit: 100, review_status: "pending_review" }),
    client.listDrafts({ limit: 100, review_status: "approved" }),
  ]);
  const draftIds = new Set(
    draftLists.flatMap((list) => list.drafts.map((draft) => draft.paper_uuid)),
  );
  const drafts = await Promise.all(
    [...draftIds].map((paperUuid) => client.getDraft(paperUuid)),
  );
  for (const draft of drafts) {
    addCurrentPaperbotRepository(repositories, draft);
  }
  return repositories;
}

function addCurrentPaperbotRepository(
  repositories: Set<string>,
  paper: PublishedPaperSummary | PaperDraft,
): void {
  const metadata =
    "metadata" in paper
      ? paper.metadata
      : markdownMetadata(paper.source_markdown);
  if (metadata === undefined || !isCurrentPaperbotMetadata(metadata)) {
    return;
  }
  const repository = canonicalGitHubRepository(metadata.repository_url);
  if (repository !== undefined) {
    repositories.add(repository);
  }
}

function markdownMetadata(sourceMarkdown: string): unknown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(sourceMarkdown);
  if (match?.[1] === undefined) {
    return undefined;
  }
  try {
    return Bun.YAML.parse(match[1]) as unknown;
  } catch {
    return undefined;
  }
}

function isCurrentPaperbotMetadata(value: unknown): value is {
  repository_url?: unknown;
  writers: unknown[];
} {
  return (
    isRecord(value) &&
    Array.isArray(value.writers) &&
    value.writers.some(
      (writer) =>
        isRecord(writer) &&
        writer.kind === "agent" &&
        typeof writer.name === "string" &&
        writer.name.toLowerCase() === "paperbot" &&
        writer.tool_version === PAPERBOT_VERSION,
    )
  );
}

function canonicalGitHubRepository(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  const parts = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  if (parts.length !== 2) {
    return undefined;
  }
  const repository = parts[1]?.replace(/\.git$/i, "");
  if (parts[0] === undefined || repository === undefined || repository === "") {
    return undefined;
  }
  return `${parts[0]}/${repository}`.toLowerCase();
}

function configuredApiUrl(value: string): string {
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("PRODXIV_API_URL must use HTTPS or loopback HTTP");
  }
  return url.toString();
}

function parseSelection(value: unknown, path: string): TrendSelection {
  if (!isRecord(value) || !Array.isArray(value.selected_repositories)) {
    throw new Error(`invalid Paperbot trend selection: ${path}`);
  }
  return {
    selected_repositories: value.selected_repositories.map((project, index) => {
      if (
        !isRecord(project) ||
        typeof project.repository_full_name !== "string" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project.repository_full_name)
      ) {
        throw new Error(`invalid selected repository ${index + 1}`);
      }
      return { repository_full_name: project.repository_full_name };
    }),
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  await main();
}
