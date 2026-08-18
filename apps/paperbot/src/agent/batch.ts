import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  canonicalizeGitHubRepositoryUrl,
  type CanonicalGitHubRepository,
} from "@prodxiv/paperbot-source";
import { ExitCode, PaperbotError } from "@prodxiv/paperbot-core";
import {
  isAgentPaperStatus,
  MAX_AGENT_AUTHORS,
  MAX_AGENT_TEXT_LENGTH,
  MAX_AGENT_URL_LENGTH,
  normalizeAgentRequestMetadata,
  normalizeAnonymousHttpUrl,
  normalizeExternalSources,
  normalizeText,
  type AgentPaperStatus,
} from "./input.ts";
import { initializeRunDirectory, writeJsonArtifact } from "./artifacts.ts";
import { redactModelSecrets } from "./model-config.ts";
import { runAgent, type AgentRunOptions } from "./runner.ts";
import type {
  AgentGitHubReleasePolicy,
  AgentPaperRequestMetadata,
  AgentRunMode,
  AgentRunResult,
} from "./types.ts";

export const AGENT_BATCH_SCHEMA_VERSION = "1";
export const AGENT_BATCH_REPORT_SCHEMA_VERSION = "2";
export const MAX_AGENT_BATCH_PROJECTS = 100;
export const MAX_AGENT_BATCH_CONCURRENCY = 4;

const MAX_BATCH_MANIFEST_BYTES = 1024 * 1024;

export type { AgentPaperStatus } from "./input.ts";

export interface AgentBatchProject {
  repository_url: string;
  ref?: string;
  title?: string;
  product_name?: string;
  product_url?: string;
  authors?: string[];
  status?: AgentPaperStatus;
  external_sources?: string[];
}

export interface AgentBatchManifest {
  schema_version: typeof AGENT_BATCH_SCHEMA_VERSION;
  github_release_policy?: AgentGitHubReleasePolicy;
  projects: AgentBatchProject[];
}

export interface AgentBatchOptions {
  input_path: string;
  output_path: string;
  allow_remote_model: boolean;
  mode?: AgentRunMode;
  authors?: string[];
  status?: AgentPaperStatus;
  model?: string;
  concurrency?: number;
}

export interface AgentBatchDependencies {
  run_agent?: (options: AgentRunOptions) => Promise<AgentRunResult>;
  now?: () => Date;
}

export type AgentBatchProjectState =
  "pending" | "running" | "succeeded" | "failed";

export interface AgentBatchProjectReport {
  project_index: number;
  repository_url: string;
  output_path: string;
  state: AgentBatchProjectState;
  metadata?: AgentPaperRequestMetadata;
  started_at?: string;
  completed_at?: string;
  result?: AgentRunResult;
  error?: {
    message: string;
  };
}

export interface AgentBatchReport {
  schema_version: typeof AGENT_BATCH_REPORT_SCHEMA_VERSION;
  started_at: string;
  updated_at: string;
  input: {
    input_path: string;
    allow_remote_model: true;
    mode: AgentRunMode;
    concurrency: number;
    github_release_policy: AgentGitHubReleasePolicy;
    authors?: string[];
    status?: AgentPaperStatus;
    model?: string;
  };
  projects: AgentBatchProjectReport[];
  summary: {
    total: number;
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
  };
}

export interface AgentBatchResult {
  output_path: string;
  report: AgentBatchReport;
}

interface ParsedBatchProject extends AgentBatchProject {
  repository: CanonicalGitHubRepository;
}

interface ParsedBatchManifest {
  schema_version: typeof AGENT_BATCH_SCHEMA_VERSION;
  github_release_policy: AgentGitHubReleasePolicy;
  projects: ParsedBatchProject[];
}

/**
 * Run a manifest of public GitHub projects without granting the model any
 * publication capability. Each project receives an isolated child directory;
 * one failed project never stops another project from being drafted.
 */
export async function runAgentBatch(
  options: AgentBatchOptions,
  dependencies: AgentBatchDependencies = {},
): Promise<AgentBatchResult> {
  const normalizedOptions = normalizeOptions(options);
  if (!normalizedOptions.allow_remote_model) {
    throw usageError(
      "agent batch requires --allow-remote-model before source content is sent to a model",
    );
  }

  const manifest = await loadParsedBatchManifest(normalizedOptions.input_path);
  const outputPath = await initializeRunDirectory(
    normalizedOptions.output_path,
  );
  const startedAt = now(dependencies).toISOString();
  const report: AgentBatchReport = {
    schema_version: AGENT_BATCH_REPORT_SCHEMA_VERSION,
    started_at: startedAt,
    updated_at: startedAt,
    input: {
      input_path: resolve(normalizedOptions.input_path),
      allow_remote_model: true,
      mode: normalizedOptions.mode,
      concurrency: normalizedOptions.concurrency,
      github_release_policy: manifest.github_release_policy,
      ...(normalizedOptions.authors === undefined
        ? {}
        : { authors: normalizedOptions.authors }),
      ...(normalizedOptions.status === undefined
        ? {}
        : { status: normalizedOptions.status }),
      ...(normalizedOptions.model === undefined
        ? {}
        : { model: normalizedOptions.model }),
    },
    projects: manifest.projects.map((project, index) => ({
      project_index: index + 1,
      repository_url: project.repository.canonical_url,
      output_path: childOutputPath(outputPath, project.repository),
      state: "pending",
    })),
    summary: {
      total: manifest.projects.length,
      pending: manifest.projects.length,
      running: 0,
      succeeded: 0,
      failed: 0,
    },
  };

  let reportWrites = Promise.resolve();
  const persistReport = async (): Promise<void> => {
    refreshReportSummary(report, now(dependencies));
    const snapshot = cloneReport(report);
    reportWrites = reportWrites.then(async () => {
      await writeJsonArtifact(outputPath, "batch.json", snapshot);
    });
    await reportWrites;
  };

  await persistReport();
  const executeProject = async (projectIndex: number): Promise<void> => {
    const project = manifest.projects[projectIndex];
    const projectReport = report.projects[projectIndex];
    if (project === undefined || projectReport === undefined) {
      throw new Error("agent batch project index was out of range");
    }

    try {
      const metadata = projectMetadata(project, normalizedOptions);
      projectReport.metadata = metadata;
      projectReport.state = "running";
      projectReport.started_at = now(dependencies).toISOString();
      await persistReport();

      const result = await (dependencies.run_agent ?? runAgent)({
        repository: project.repository.canonical_url,
        output_path: projectReport.output_path,
        allow_remote_model: true,
        mode: normalizedOptions.mode,
        feedback: normalizedOptions.mode === "auto" ? "none" : "async",
        metadata,
        external_sources: project.external_sources ?? [],
        github_release_policy: manifest.github_release_policy,
        ...(project.ref === undefined ? {} : { ref: project.ref }),
        ...(normalizedOptions.model === undefined
          ? {}
          : { model: normalizedOptions.model }),
      });
      projectReport.result = result;
      if (!result.validation.valid) {
        projectReport.state = "failed";
        projectReport.error = {
          message: `agent draft did not pass validation (${result.validation.diagnostics} diagnostics)`,
        };
      } else if (
        result.mode !== normalizedOptions.mode ||
        result.feedback !==
          (normalizedOptions.mode === "auto" ? "none" : "async")
      ) {
        projectReport.state = "failed";
        projectReport.error = {
          message: `agent returned an unexpected mode: ${result.mode}/${result.feedback}`,
        };
      } else if (
        result.state !== "needs_author_review" &&
        (normalizedOptions.mode === "auto" ||
          result.state !== "awaiting_author")
      ) {
        projectReport.state = "failed";
        projectReport.error = {
          message: `agent returned an unexpected terminal state: ${result.state}`,
        };
      } else {
        projectReport.state = "succeeded";
      }
    } catch (error) {
      projectReport.state = "failed";
      projectReport.error = { message: safeErrorMessage(error) };
    }

    projectReport.completed_at = now(dependencies).toISOString();
    await persistReport();
  };

  let nextProjectIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextProjectIndex < manifest.projects.length) {
      const projectIndex = nextProjectIndex;
      nextProjectIndex += 1;
      await executeProject(projectIndex);
    }
  };
  const workerCount = Math.min(
    normalizedOptions.concurrency,
    manifest.projects.length,
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  await persistReport();

  return { output_path: outputPath, report };
}

export async function loadAgentBatchManifest(
  inputPath: string,
): Promise<AgentBatchManifest> {
  const manifest = await loadParsedBatchManifest(inputPath);
  return {
    schema_version: manifest.schema_version,
    github_release_policy: manifest.github_release_policy,
    projects: manifest.projects.map(({ repository, ...project }) => project),
  };
}

async function loadParsedBatchManifest(
  inputPath: string,
): Promise<ParsedBatchManifest> {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    throw usageError("agent batch requires a manifest path");
  }

  const absoluteInputPath = resolve(inputPath);
  let serialized: string;
  try {
    const metadata = await lstat(absoluteInputPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_BATCH_MANIFEST_BYTES
    ) {
      throw new Error("unsupported manifest file");
    }
    serialized = await readFile(absoluteInputPath, "utf8");
  } catch {
    throw new PaperbotError(
      `could not read agent batch manifest: ${inputPath}`,
      ExitCode.io,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw usageError("agent batch manifest is not valid JSON");
  }
  return parseBatchManifest(value);
}

function parseBatchManifest(value: unknown): ParsedBatchManifest {
  if (!isRecord(value)) {
    throw usageError("agent batch manifest must be a JSON object");
  }
  assertKnownFields(
    value,
    ["schema_version", "github_release_policy", "projects"],
    "agent batch manifest",
  );
  if (value.schema_version !== AGENT_BATCH_SCHEMA_VERSION) {
    throw usageError(
      `agent batch manifest schema_version must be ${AGENT_BATCH_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(value.projects)) {
    throw usageError("agent batch manifest projects must be an array");
  }
  if (value.projects.length === 0) {
    throw usageError("agent batch manifest projects must not be empty");
  }
  if (value.projects.length > MAX_AGENT_BATCH_PROJECTS) {
    throw usageError(
      `agent batch manifest contains too many projects; maximum is ${MAX_AGENT_BATCH_PROJECTS}`,
    );
  }

  const projects = value.projects.map((project, index) =>
    parseBatchProject(project, index),
  );
  const githubReleasePolicy = parseGitHubReleasePolicy(
    value.github_release_policy,
  );
  const duplicate = findDuplicateRepository(projects);
  if (duplicate !== undefined) {
    throw usageError(
      `agent batch manifest contains the same repository more than once: ${duplicate}`,
    );
  }
  return {
    schema_version: AGENT_BATCH_SCHEMA_VERSION,
    github_release_policy: githubReleasePolicy,
    projects,
  };
}

function parseBatchProject(value: unknown, index: number): ParsedBatchProject {
  const label = `agent batch project ${index + 1}`;
  if (!isRecord(value)) {
    throw usageError(`${label} must be a JSON object`);
  }
  assertKnownFields(
    value,
    [
      "repository_url",
      "ref",
      "title",
      "product_name",
      "product_url",
      "authors",
      "status",
      "external_sources",
    ],
    label,
  );
  const repositoryUrl = readTextField(
    value.repository_url,
    `${label}.repository_url`,
    MAX_AGENT_URL_LENGTH,
  );
  let repository: CanonicalGitHubRepository;
  try {
    repository = canonicalizeGitHubRepositoryUrl(repositoryUrl);
  } catch {
    throw usageError(
      `${label}.repository_url must be an anonymous canonical https://github.com/<owner>/<repo> URL`,
    );
  }

  const ref = optionalTextField(
    value.ref,
    `${label}.ref`,
    MAX_AGENT_TEXT_LENGTH,
  );
  if (ref !== undefined) {
    assertSafeGitRef(ref, `${label}.ref`);
  }
  const title = optionalTextField(
    value.title,
    `${label}.title`,
    MAX_AGENT_TEXT_LENGTH,
  );
  const productName = optionalTextField(
    value.product_name,
    `${label}.product_name`,
    MAX_AGENT_TEXT_LENGTH,
  );
  const productUrl = optionalUrlField(
    value.product_url,
    `${label}.product_url`,
  );
  const authors = optionalAuthors(value.authors, `${label}.authors`);
  const status = optionalStatus(value.status, `${label}.status`);
  const externalSources = optionalExternalSources(
    value.external_sources,
    `${label}.external_sources`,
  );

  return {
    repository_url: repository.canonical_url,
    ...(ref === undefined ? {} : { ref }),
    ...(title === undefined ? {} : { title }),
    ...(productName === undefined ? {} : { product_name: productName }),
    ...(productUrl === undefined ? {} : { product_url: productUrl }),
    ...(authors === undefined ? {} : { authors }),
    ...(status === undefined ? {} : { status }),
    ...(externalSources === undefined
      ? {}
      : { external_sources: externalSources }),
    repository,
  };
}

function normalizeOptions(options: AgentBatchOptions): {
  input_path: string;
  output_path: string;
  allow_remote_model: boolean;
  mode: AgentRunMode;
  authors?: string[];
  status?: AgentPaperStatus;
  model?: string;
  concurrency: number;
} {
  if (
    typeof options.input_path !== "string" ||
    options.input_path.trim().length === 0
  ) {
    throw usageError("agent batch requires a manifest path");
  }
  if (
    typeof options.output_path !== "string" ||
    options.output_path.trim().length === 0
  ) {
    throw usageError("agent batch requires --output");
  }
  if (typeof options.allow_remote_model !== "boolean") {
    throw usageError(
      "agent batch requires an explicit allow_remote_model value",
    );
  }

  const authors = optionalAuthors(options.authors, "agent batch authors");
  const status = optionalStatus(options.status, "agent batch status");
  const model = optionalTextField(
    options.model,
    "agent batch model",
    MAX_AGENT_TEXT_LENGTH,
  );
  const concurrency = options.concurrency ?? 1;
  const mode = options.mode ?? "auto";
  if (mode !== "auto" && mode !== "interactive") {
    throw usageError("agent batch mode must be interactive or auto");
  }
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_AGENT_BATCH_CONCURRENCY
  ) {
    throw usageError(
      `agent batch concurrency must be an integer from 1 to ${MAX_AGENT_BATCH_CONCURRENCY}`,
    );
  }

  return {
    input_path: options.input_path,
    output_path: options.output_path,
    allow_remote_model: options.allow_remote_model,
    mode,
    ...(authors === undefined ? {} : { authors }),
    ...(status === undefined ? {} : { status }),
    ...(model === undefined ? {} : { model }),
    concurrency,
  };
}

function projectMetadata(
  project: ParsedBatchProject,
  options: ReturnType<typeof normalizeOptions>,
): AgentPaperRequestMetadata {
  const authors = project.authors ?? options.authors;
  const status = project.status ?? options.status;
  const productName =
    project.product_name ??
    productNameFromRepository(project.repository.repository);
  return normalizeAgentRequestMetadata({
    title: project.title ?? `${productName} research draft`,
    product_name: productName,
    ...(authors === undefined ? {} : { authors }),
    ...(status === undefined ? {} : { status }),
    ...(project.product_url === undefined
      ? {}
      : { product_url: project.product_url }),
    repository_url: project.repository.canonical_url,
  });
}

function childOutputPath(
  outputPath: string,
  repository: CanonicalGitHubRepository,
): string {
  // GitHub owner names cannot contain underscores, so this separator remains
  // collision-free even when repository names contain hyphens or underscores.
  const childName = `${repository.owner.toLowerCase()}__${repository.repository.toLowerCase()}`;
  return join(outputPath, childName);
}

function productNameFromRepository(repository: string): string {
  return repository.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function refreshReportSummary(report: AgentBatchReport, timestamp: Date): void {
  let pending = 0;
  let running = 0;
  let succeeded = 0;
  let failed = 0;
  for (const project of report.projects) {
    if (project.state === "pending") {
      pending += 1;
    } else if (project.state === "running") {
      running += 1;
    } else if (project.state === "succeeded") {
      succeeded += 1;
    } else {
      failed += 1;
    }
  }
  report.summary = {
    total: report.projects.length,
    pending,
    running,
    succeeded,
    failed,
  };
  report.updated_at = timestamp.toISOString();
}

function cloneReport(report: AgentBatchReport): AgentBatchReport {
  return JSON.parse(JSON.stringify(report)) as AgentBatchReport;
}

function findDuplicateRepository(
  projects: ParsedBatchProject[],
): string | undefined {
  const seen = new Set<string>();
  for (const project of projects) {
    const key = project.repository.canonical_url.toLowerCase();
    if (seen.has(key)) {
      return project.repository.canonical_url;
    }
    seen.add(key);
  }
  return undefined;
}

function parseGitHubReleasePolicy(value: unknown): AgentGitHubReleasePolicy {
  if (value === undefined) {
    return "best_effort";
  }
  if (value !== "best_effort" && value !== "disabled") {
    throw usageError(
      "agent batch github_release_policy must be best_effort or disabled",
    );
  }
  return value;
}

function optionalExternalSources(
  value: unknown,
  _label: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return normalizeExternalSources(value);
}

function optionalUrlField(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return normalizeAnonymousHttpUrl(value, label);
}

function optionalAuthors(value: unknown, label: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > MAX_AGENT_AUTHORS) {
    throw usageError(
      `${label} must contain at most ${MAX_AGENT_AUTHORS} names`,
    );
  }
  const authors = value.map((author, index) =>
    readTextField(author, `${label}[${index}]`, MAX_AGENT_TEXT_LENGTH),
  );
  return uniqueStrings(authors, label);
}

function optionalStatus(
  value: unknown,
  label: string,
): AgentPaperStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isAgentPaperStatus(value)) {
    throw usageError(
      `${label} must be one of: concept, private_beta, public_beta, launched, discontinued`,
    );
  }
  return value;
}

function optionalTextField(
  value: unknown,
  label: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readTextField(value, label, maximumLength);
}

function readTextField(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  return normalizeText(value, label, maximumLength);
}

function uniqueStrings(values: string[], label: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw usageError(`${label} must not contain duplicate values`);
    }
    seen.add(value);
  }
  return values;
}

function assertSafeGitRef(value: string, label: string): void {
  if (
    value === "." ||
    value === "@" ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\u0000-\u001f\u007f~^:?*[\\\s]/.test(value)
  ) {
    throw usageError(
      `${label} must be a safe Git branch, tag, or commit reference`,
    );
  }
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowedFields: string[],
  label: string,
): void {
  const allowed = new Set(allowedFields);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw usageError(
      `${label} has unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function now(dependencies: AgentBatchDependencies): Date {
  return (dependencies.now ?? (() => new Date()))();
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactModelSecrets(message);
}

function usageError(message: string): PaperbotError {
  return new PaperbotError(message, ExitCode.usage);
}
