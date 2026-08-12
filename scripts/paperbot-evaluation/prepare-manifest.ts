import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const CANARY_COUNT = 3;
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
  canaryPath: string,
  selectionPath: string,
): Promise<EvaluationManifest> {
  const canaries = parseManifest(await readJson(canaryPath), canaryPath);
  if (canaries.projects.length !== CANARY_COUNT) {
    throw new Error(
      `daily Paperbot canaries must contain ${CANARY_COUNT} projects`,
    );
  }
  const selection = parseSelection(
    await readJson(selectionPath),
    selectionPath,
  );
  const canaryNames = new Set(
    canaries.projects.map((project) => repositoryName(project.repository_url)),
  );
  const discovery = selection.selected_repositories
    .map((project) => project.repository_full_name.toLowerCase())
    .filter((name) => !canaryNames.has(name))
    .slice(0, DISCOVERY_COUNT)
    .map((name) => ({
      repository_url: `https://github.com/${name}`,
    }));
  if (discovery.length !== DISCOVERY_COUNT) {
    throw new Error(
      `daily Paperbot selection did not provide ${DISCOVERY_COUNT} non-canary repositories`,
    );
  }
  return {
    schema_version: "1",
    projects: [...canaries.projects, ...discovery],
  };
}

async function main(): Promise<void> {
  const [canaryPath, selectionPath, outputPath] = process.argv.slice(2);
  if (
    canaryPath === undefined ||
    selectionPath === undefined ||
    outputPath === undefined
  ) {
    throw new Error(
      "usage: prepare-manifest.ts <canaries.json> <selection.json> <output.json>",
    );
  }
  const manifest = await prepareEvaluationManifest(
    resolve(canaryPath),
    resolve(selectionPath),
  );
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function parseManifest(value: unknown, path: string): EvaluationManifest {
  if (
    !isRecord(value) ||
    value.schema_version !== "1" ||
    !Array.isArray(value.projects)
  ) {
    throw new Error(`invalid daily Paperbot canary manifest: ${path}`);
  }
  const projects = value.projects.map((project, index) => {
    if (
      !isRecord(project) ||
      typeof project.repository_url !== "string" ||
      typeof project.ref !== "string" ||
      !/^[0-9a-f]{40}$/.test(project.ref)
    ) {
      throw new Error(`invalid daily Paperbot canary project ${index + 1}`);
    }
    repositoryName(project.repository_url);
    return {
      repository_url: project.repository_url,
      ref: project.ref,
    };
  });
  if (
    new Set(projects.map((project) => repositoryName(project.repository_url)))
      .size !== projects.length
  ) {
    throw new Error("daily Paperbot canaries must be unique");
  }
  return { schema_version: "1", projects };
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

function repositoryName(url: string): string {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(url);
  if (match?.[1] === undefined) {
    throw new Error(`invalid canonical GitHub repository URL: ${url}`);
  }
  return match[1].toLowerCase();
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
