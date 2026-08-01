import { lstat, readFile } from "node:fs/promises";

import { marked, type Token, type Tokens } from "marked";

import {
  ExitCode,
  PaperbotError,
  validatePaperSource,
  type PaperValidationResult,
} from "@prodxiv/paperbot-core";
import {
  canonicalizeGitHubRepositoryUrl,
  fetchGitHubSource,
  GitHubSourceError,
  type GitHubSourceFetch,
} from "@prodxiv/paperbot-source";
import {
  artifactPath,
  ensureRunDirectory,
  initializeRunDirectory,
  sha256,
  writeJsonArtifact,
  writeTextArtifact,
} from "./artifacts.ts";
import {
  normalizeAgentMetadata,
  normalizeAnonymousHttpUrl,
  normalizeExternalSources,
} from "./input.ts";
import { redactModelSecrets } from "./model-config.ts";
import { PiAuthoringRuntime } from "./pi.ts";
import {
  createDraftPrompt,
  createRepairPrompt,
  createReviewPrompt,
} from "./prompts.ts";
import {
  parseDraftResponse,
  parseReviewResponse,
  validateEvidenceSourceIds,
  validateReviewSourceIds,
} from "./responses.ts";
import {
  acquireLocalSource,
  agent_source_limits,
  readSourceArtifact,
  sourceFromGitHubResult,
  writeSourceArtifacts,
} from "./source.ts";
import type {
  AgentPaperMetadata,
  AgentRunRecord,
  AgentRunResult,
  AgentRunSourceRecord,
  AgentSource,
  AuthoringRuntime,
  DraftResponse,
  ReviewResponse,
} from "./types.ts";

const MAX_RESUME_DRAFT_BYTES = 256 * 1024;
const MAX_AUTHOR_ANSWERS_BYTES = 32 * 1024;
const MAX_RUN_RECORD_BYTES = 128 * 1024;
const MAX_REVIEW_BYTES = 128 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export interface AgentRunOptions {
  repository: string;
  output_path: string;
  allow_remote_model: boolean;
  metadata: AgentPaperMetadata;
  external_sources?: string[];
  ref?: string;
  model?: string;
}

export interface AgentResumeOptions {
  run_path: string;
  allow_remote_model: boolean;
  answers_path: string;
  model?: string;
}

export interface AgentRunnerDependencies {
  create_runtime?: (model: string) => AuthoringRuntime;
  fetch?: GitHubSourceFetch;
  now?: () => Date;
}

export async function runAgent(
  options: AgentRunOptions,
  dependencies: AgentRunnerDependencies = {},
): Promise<AgentRunResult> {
  if (!options.allow_remote_model) {
    throw new PaperbotError(
      "agent run requires --allow-remote-model before source content is sent to a model",
      ExitCode.usage,
    );
  }
  const requestedMetadata = normalizeAgentMetadata(options.metadata);
  const externalSources = normalizeExternalSources(
    options.external_sources ?? [],
  );
  const runPath = await initializeRunDirectory(options.output_path);
  const model = normalizeModelName(options.model ?? "deepseek-v4-flash");
  let record: AgentRunRecord = createRunRecord(
    { ...options, metadata: requestedMetadata },
    model,
    externalSources,
    dependencies,
  );
  await persistRunRecord(runPath, record);

  try {
    const source = await acquireSource(options, dependencies);
    const metadata = completeMetadata(requestedMetadata, source);
    record = {
      ...record,
      updated_at: now(dependencies).toISOString(),
      input: {
        ...record.input,
        metadata,
      },
      state: "source_ready",
      source: sourceRecord(source),
    };
    const sourceArtifacts = await writeSourceArtifacts(runPath, source);
    record.artifacts.source = relativeArtifact(
      runPath,
      sourceArtifacts.source_path,
    );
    record.artifacts.scan = relativeArtifact(
      runPath,
      sourceArtifacts.scan_path,
    );
    await persistRunRecord(runPath, record);

    const runtime = runtimeFor(model, dependencies);
    const draft = await generateDraft(runtime, {
      source,
      metadata,
      external_sources: externalSources,
      run_path: runPath,
    });
    const allowedSourceIds = availableEvidenceSourceIds(source);
    validateEvidenceSourceIds(draft.evidence, allowedSourceIds);
    const initialDraftLinkDiagnostics = draftLinkDiagnostics(
      draft.markdown,
      allowedMarkdownUrls(metadata, externalSources),
    );
    const initialDraftFieldDiagnostics = draftFieldDiagnostics(draft);
    let paper = renderPaper(metadata, draft);
    let validation = validatePaperSource(
      paper,
      artifactPath(runPath, "draft.md"),
      "draft",
    );
    const initialDraftIsValid =
      validation.report.valid &&
      initialDraftFieldDiagnostics.length === 0 &&
      initialDraftLinkDiagnostics.length === 0;

    record.state = "drafted";
    record.updated_at = now(dependencies).toISOString();
    if (initialDraftIsValid) {
      await writeDraftArtifacts(runPath, draft, paper);
      record.artifacts.evidence = "evidence.jsonl";
      record.artifacts.draft = "draft.md";
      record.artifacts.questions = "questions.md";
      record.draft_sha256 = sha256(paper);
    }
    await persistRunRecord(runPath, record);

    const review = await generateReview(runtime, {
      source,
      metadata,
      external_sources: externalSources,
      draft,
      run_path: runPath,
    });
    validateReviewSourceIds(review, allowedSourceIds);
    await writeJsonArtifact(runPath, "review.json", {
      schema_version: "1",
      reviewed_at: now(dependencies).toISOString(),
      issues: review.issues,
      questions: review.questions,
    });
    await writeJsonArtifact(runPath, "validation.json", validation.report);
    record.artifacts.review = "review.json";
    record.artifacts.validation = "validation.json";
    record.state = "reviewed";
    record.updated_at = now(dependencies).toISOString();
    await persistRunRecord(runPath, record);

    if (
      review.issues.some((issue) => issue.severity === "error") ||
      !validation.report.valid ||
      initialDraftFieldDiagnostics.length > 0 ||
      initialDraftLinkDiagnostics.length > 0
    ) {
      const repaired = await generateRepair(runtime, {
        source,
        metadata,
        external_sources: externalSources,
        draft,
        review,
        validation_diagnostics: validation.report.diagnostics
          .map(
            (diagnostic) =>
              `${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
          )
          .concat(initialDraftFieldDiagnostics, initialDraftLinkDiagnostics),
        run_path: runPath,
      });
      validateEvidenceSourceIds(repaired.evidence, allowedSourceIds);
      assertValidDraftFields(repaired);
      validateDraftLinks(
        repaired.markdown,
        allowedMarkdownUrls(metadata, externalSources),
      );
      paper = renderPaper(metadata, repaired);
      validation = validatePaperSource(
        paper,
        artifactPath(runPath, "draft.md"),
        "draft",
      );
      assertValidGeneratedPaper(validation, "revision");
      await writeDraftArtifacts(runPath, repaired, paper, review.questions);
      record.artifacts.evidence = "evidence.jsonl";
      record.artifacts.draft = "draft.md";
      record.artifacts.questions = "questions.md";
      record.draft_sha256 = sha256(paper);
      await writeJsonArtifact(runPath, "validation.json", validation.report);
    }

    record.state = "needs_author_review";
    record.updated_at = now(dependencies).toISOString();
    await persistRunRecord(runPath, record);

    return {
      run_path: runPath,
      state: record.state,
      validation: {
        valid: validation.report.valid,
        diagnostics: validation.report.diagnostics.length,
      },
      source: {
        resolved_revision: source.resolved_revision,
        selected_file_count: source.files.length,
      },
    };
  } catch (error) {
    record.state = "failed";
    record.updated_at = now(dependencies).toISOString();
    record.error = { message: safeErrorMessage(error) };
    await persistRunRecord(runPath, record).catch(() => undefined);
    throw error;
  }
}

export async function resumeAgent(
  options: AgentResumeOptions,
  dependencies: AgentRunnerDependencies = {},
): Promise<AgentRunResult> {
  if (!options.allow_remote_model) {
    throw new PaperbotError(
      "agent resume requires --allow-remote-model before source content is sent to a model",
      ExitCode.usage,
    );
  }
  const runPath = await resolveExistingRun(options.run_path);
  const record = await readRunRecord(runPath);
  const metadata = normalizeAgentMetadata(record.input.metadata);
  const externalSources = normalizeExternalSources(
    record.input.external_sources,
  );
  const draftPath = artifactPath(runPath, "draft.md");
  const currentDraft = await readArtifact(
    draftPath,
    "draft",
    MAX_RESUME_DRAFT_BYTES,
  );
  const answers = await readArtifact(
    options.answers_path,
    "answers",
    MAX_AUTHOR_ANSWERS_BYTES,
  );
  const source = await readSourceArtifact(runPath);
  assertRestoredSourceMatchesRunRecord(source, record, runPath);
  const review = await readReviewArtifact(
    runPath,
    availableEvidenceSourceIds(source),
  );
  const runtime = runtimeFor(
    normalizeModelName(options.model ?? record.agent.model),
    dependencies,
  );
  const draft = draftFromPaper(currentDraft);
  const repaired = await generateRepair(runtime, {
    source,
    metadata,
    external_sources: externalSources,
    draft,
    review,
    validation_diagnostics: [],
    answers,
    run_path: runPath,
  });
  const allowedSourceIds = availableEvidenceSourceIds(source, true);
  validateEvidenceSourceIds(repaired.evidence, allowedSourceIds);
  assertValidDraftFields(repaired);
  validateDraftLinks(
    repaired.markdown,
    allowedMarkdownUrls(metadata, externalSources),
  );
  const proposal = renderPaper(metadata, repaired);
  const proposalName = await nextProposalName(runPath);
  const validation = validatePaperSource(
    proposal,
    artifactPath(runPath, proposalName),
    "draft",
  );
  assertValidGeneratedPaper(validation, "proposal");
  await writeTextArtifact(runPath, proposalName, proposal);
  await writeJsonArtifact(
    runPath,
    `${proposalName}.validation.json`,
    validation.report,
  );
  return {
    run_path: runPath,
    state: "needs_author_review",
    validation: {
      valid: validation.report.valid,
      diagnostics: validation.report.diagnostics.length,
    },
    source: {
      resolved_revision: source.resolved_revision,
      selected_file_count: source.files.length,
    },
  };
}

export function renderPaper(
  metadata: AgentPaperMetadata,
  draft: Pick<DraftResponse, "summary" | "topics" | "markdown">,
): string {
  const frontMatter = [
    'schema_version: "1"',
    `title: ${JSON.stringify(metadata.title)}`,
    `product_name: ${JSON.stringify(metadata.product_name)}`,
    "scope:",
    "  kind: product",
    `summary: ${JSON.stringify(draft.summary.trim())}`,
    "authors:",
    ...metadata.authors.map((author) => `  - name: ${JSON.stringify(author)}`),
    `status: ${JSON.stringify(metadata.status)}`,
    "topics:",
    ...draft.topics.map((topic) => `  - ${JSON.stringify(topic)}`),
    ...(metadata.product_url === undefined
      ? []
      : [`product_url: ${JSON.stringify(metadata.product_url)}`]),
    ...(metadata.repository_url === undefined
      ? []
      : [`repository_url: ${JSON.stringify(metadata.repository_url)}`]),
  ].join("\n");
  const notice = [
    "> **Private research draft.** This paper was generated from bounded public repository evidence and has not been reviewed or endorsed by the product maintainers.",
    "> Confirm factual claims, product status, author attribution, related-work comparisons, and publication rights before submitting it.",
  ].join("\n");
  return `---\n${frontMatter}\n---\n\n${notice}\n\n${draft.markdown.trim()}\n`;
}

async function acquireSource(
  options: AgentRunOptions,
  dependencies: AgentRunnerDependencies,
): Promise<AgentSource> {
  if (options.repository.startsWith("https://github.com/")) {
    try {
      return sourceFromGitHubResult(
        await fetchGitHubSource({
          repository_url: options.repository,
          ...(options.ref === undefined ? {} : { ref: options.ref }),
          ...(dependencies.fetch === undefined
            ? {}
            : { fetch: dependencies.fetch }),
          limits: agent_source_limits,
        }),
      );
    } catch (error) {
      if (error instanceof GitHubSourceError) {
        throw new PaperbotError(
          `GitHub source ${error.code}: ${error.message}`,
          error.code === "network_request_failed"
            ? ExitCode.network
            : ExitCode.scan,
        );
      }
      throw error;
    }
  }
  if (/^https?:\/\//i.test(options.repository)) {
    throw new PaperbotError(
      "agent remote repositories must use an anonymous canonical https://github.com/<owner>/<repo> URL",
      ExitCode.usage,
    );
  }
  return acquireLocalSource(options.repository);
}

function runtimeFor(
  model: string,
  dependencies: AgentRunnerDependencies,
): AuthoringRuntime {
  return (
    dependencies.create_runtime?.(model) ?? new PiAuthoringRuntime({ model })
  );
}

function normalizeModelName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._/-]{1,200}$/.test(value)) {
    throw new PaperbotError(
      "agent model must contain only provider-safe identifier characters",
      ExitCode.usage,
    );
  }
  return value;
}

async function generateDraft(
  runtime: AuthoringRuntime,
  input: {
    source: AgentSource;
    metadata: AgentPaperMetadata;
    external_sources: string[];
    run_path: string;
  },
): Promise<DraftResponse> {
  return parseWithOneRetry(
    runtime,
    createDraftPrompt(input),
    input.run_path,
    parseDraftResponse,
    "initial draft",
  );
}

async function generateReview(
  runtime: AuthoringRuntime,
  input: {
    source: AgentSource;
    metadata: AgentPaperMetadata;
    external_sources: string[];
    draft: DraftResponse;
    run_path: string;
  },
): Promise<ReviewResponse> {
  return parseWithOneRetry(
    runtime,
    createReviewPrompt(input),
    input.run_path,
    parseReviewResponse,
    "review",
  );
}

async function generateRepair(
  runtime: AuthoringRuntime,
  input: {
    source: AgentSource;
    metadata: AgentPaperMetadata;
    external_sources: string[];
    draft: DraftResponse;
    review: ReviewResponse;
    validation_diagnostics: string[];
    answers?: string;
    run_path: string;
  },
): Promise<DraftResponse> {
  return parseWithOneRetry(
    runtime,
    createRepairPrompt(input),
    input.run_path,
    parseDraftResponse,
    "revision",
  );
}

async function parseWithOneRetry<T>(
  runtime: AuthoringRuntime,
  prompt: string,
  runPath: string,
  parser: (value: string) => T,
  operation: string,
): Promise<T> {
  let response = await runtime.complete({ prompt, run_path: runPath });
  try {
    return parser(response.final_text);
  } catch (firstError) {
    if (!(firstError instanceof PaperbotError)) {
      throw firstError;
    }
    response = await runtime.complete({
      prompt: `${prompt}\n\nYour previous ${operation} response could not be parsed: ${firstError.message}\nReturn exactly one valid fenced JSON object in the requested shape, with no prose outside it.`,
      run_path: runPath,
    });
    return parser(response.final_text);
  }
}

function draftFieldDiagnostics(draft: DraftResponse): string[] {
  const diagnostics: string[] = [];
  if (draft.topics.length === 0 || draft.topics.length > 5) {
    diagnostics.push("topics must contain one to five labels");
  }
  const seen = new Set<string>();
  for (const topic of draft.topics) {
    if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(topic) || seen.has(topic)) {
      diagnostics.push("topics must be unique lowercase snake_case labels");
      break;
    }
    seen.add(topic);
  }
  if (/^#\s+Benchmarks\s*$/im.test(draft.markdown)) {
    diagnostics.push(
      "remove the Benchmarks section because no explicit reproducible benchmark input was supplied",
    );
  }
  return diagnostics;
}

function assertValidDraftFields(draft: DraftResponse): void {
  const diagnostics = draftFieldDiagnostics(draft);
  if (diagnostics.length > 0) {
    throw new PaperbotError(
      `agent returned an invalid revision: ${diagnostics.join("; ")}`,
      ExitCode.validation,
    );
  }
}

function assertValidGeneratedPaper(
  validation: PaperValidationResult,
  artifactName: "proposal" | "revision",
): void {
  if (validation.report.valid) {
    return;
  }
  const diagnostics = validation.report.diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map(
      (diagnostic) =>
        `${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
    )
    .join("; ");
  throw new PaperbotError(
    `agent returned an invalid ${artifactName}: ${diagnostics}`,
    ExitCode.validation,
  );
}

async function writeDraftArtifacts(
  runPath: string,
  draft: DraftResponse,
  paper: string,
  additionalQuestions: string[] = [],
): Promise<void> {
  await writeTextArtifact(runPath, "draft.md", paper);
  await writeTextArtifact(
    runPath,
    "evidence.jsonl",
    draft.evidence.map((item) => JSON.stringify(item)).join("\n") +
      (draft.evidence.length === 0 ? "" : "\n"),
  );
  const questions = [...new Set([...draft.questions, ...additionalQuestions])];
  await writeTextArtifact(
    runPath,
    "questions.md",
    [
      "# Author Questions",
      "",
      "These questions mark information the repository evidence cannot establish.",
      "",
      ...(questions.length === 0
        ? [
            "No additional questions were generated; review the draft before treating that as complete evidence.",
          ]
        : questions.map((question, index) => `${index + 1}. ${question}`)),
      "",
    ].join("\n"),
  );
}

function availableEvidenceSourceIds(
  source: AgentSource,
  includeAuthorAnswers = false,
): Set<string> {
  return new Set([
    ...source.files.map((file) => file.source_id),
    ...(includeAuthorAnswers ? ["author:answers"] : []),
  ]);
}

function allowedMarkdownUrls(
  metadata: AgentPaperMetadata,
  externalSources: string[],
): Set<string> {
  return new Set(
    [metadata.repository_url, metadata.product_url, ...externalSources]
      .filter((url): url is string => url !== undefined)
      .map((url) => normalizeAnonymousHttpUrl(url, "draft link")),
  );
}

function validateDraftLinks(
  markdown: string,
  allowedUrls: ReadonlySet<string>,
): void {
  let tokens: Token[];
  try {
    tokens = marked.lexer(markdown);
  } catch {
    throw new PaperbotError(
      "agent draft Markdown could not be parsed for link validation",
      ExitCode.validation,
    );
  }

  marked.walkTokens(tokens, (token) => {
    if (isRawHtmlToken(token)) {
      throw new PaperbotError(
        "agent draft contains raw HTML; use Markdown links and a host-reviewed figure instead",
        ExitCode.validation,
      );
    }
    if (isMarkdownUrlToken(token)) {
      validateMarkdownUrl(token.href, allowedUrls);
    }
  });
}

function draftLinkDiagnostics(
  markdown: string,
  allowedUrls: ReadonlySet<string>,
): string[] {
  try {
    validateDraftLinks(markdown, allowedUrls);
    return [];
  } catch (error) {
    if (error instanceof PaperbotError) {
      return [error.message];
    }
    throw error;
  }
}

function isMarkdownUrlToken(
  token: Token,
): token is Tokens.Link | Tokens.Image | Tokens.Def {
  return (
    token.type === "link" || token.type === "image" || token.type === "def"
  );
}

function isRawHtmlToken(token: Token): token is Tokens.HTML | Tokens.Tag {
  return token.type === "html";
}

function validateMarkdownUrl(
  target: string,
  allowedUrls: ReadonlySet<string>,
): void {
  let normalized: string;
  try {
    normalized = normalizeAnonymousHttpUrl(target, "draft link");
  } catch {
    throw new PaperbotError(
      `agent draft contains an unsupported Markdown link: ${target}`,
      ExitCode.validation,
    );
  }
  if (!allowedUrls.has(normalized)) {
    throw new PaperbotError(
      `agent draft links to an unprovided URL: ${normalized}`,
      ExitCode.validation,
    );
  }
}

function completeMetadata(
  metadata: AgentPaperMetadata,
  source: AgentSource,
): AgentPaperMetadata {
  const repositoryUrl =
    source.canonical_url === undefined
      ? undefined
      : normalizeOptionalSourceUrl(source.canonical_url);
  const homepageUrl =
    source.homepage_url === undefined
      ? undefined
      : normalizeOptionalSourceUrl(source.homepage_url);

  if (source.kind === "github") {
    if (repositoryUrl === undefined) {
      throw new PaperbotError(
        "acquired GitHub source did not provide a canonical repository URL",
        ExitCode.scan,
      );
    }
    if (metadata.repository_url !== undefined) {
      let requestedRepositoryUrl: string;
      try {
        requestedRepositoryUrl = canonicalizeGitHubRepositoryUrl(
          metadata.repository_url,
        ).canonical_url;
      } catch {
        throw new PaperbotError(
          "agent GitHub source repository_url must identify the acquired GitHub repository",
          ExitCode.usage,
        );
      }
      if (
        requestedRepositoryUrl.toLowerCase() !== repositoryUrl.toLowerCase()
      ) {
        throw new PaperbotError(
          "agent GitHub source repository_url must match the acquired GitHub repository",
          ExitCode.usage,
        );
      }
    }
    return normalizeAgentMetadata({
      ...metadata,
      repository_url: repositoryUrl,
      ...(metadata.product_url === undefined && homepageUrl !== undefined
        ? { product_url: homepageUrl }
        : {}),
    });
  }

  return normalizeAgentMetadata({
    ...metadata,
    ...(metadata.repository_url === undefined && repositoryUrl !== undefined
      ? { repository_url: repositoryUrl }
      : {}),
    ...(metadata.product_url === undefined && homepageUrl !== undefined
      ? { product_url: homepageUrl }
      : {}),
  });
}

function createRunRecord(
  options: AgentRunOptions,
  model: string,
  externalSources: string[],
  dependencies: AgentRunnerDependencies,
): AgentRunRecord {
  const timestamp = now(dependencies).toISOString();
  return {
    schema_version: "1",
    state: "initialized",
    started_at: timestamp,
    updated_at: timestamp,
    agent: {
      provider: "pi",
      model,
    },
    input: {
      repository: options.repository,
      allow_remote_model: true,
      external_sources: externalSources,
      metadata: options.metadata,
    },
    artifacts: {},
  };
}

function sourceRecord(source: AgentSource): AgentRunSourceRecord {
  return {
    kind: source.kind,
    ...(source.canonical_url === undefined
      ? {}
      : { canonical_url: source.canonical_url }),
    ...(source.scan_manifest.repository.source_url === undefined
      ? {}
      : { scan_source_url: source.scan_manifest.repository.source_url }),
    resolved_revision: source.resolved_revision,
    is_dirty: source.is_dirty,
    retrieved_at: source.retrieved_at,
  };
}

async function persistRunRecord(
  runPath: string,
  record: AgentRunRecord,
): Promise<void> {
  await writeJsonArtifact(runPath, "run.json", record);
}

function normalizeOptionalSourceUrl(value: string): string | undefined {
  try {
    return normalizeAnonymousHttpUrl(value, "source URL");
  } catch {
    return undefined;
  }
}

function now(dependencies: AgentRunnerDependencies): Date {
  return (dependencies.now ?? (() => new Date()))();
}

function relativeArtifact(runPath: string, artifact: string): string {
  const prefix = `${runPath}/`;
  return artifact.startsWith(prefix) ? artifact.slice(prefix.length) : artifact;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactModelSecrets(message);
}

async function resolveExistingRun(runPath: string): Promise<string> {
  const securedRunPath = await ensureRunDirectory(runPath);
  const runRecordPath = artifactPath(securedRunPath, "run.json");
  try {
    await readArtifact(runRecordPath, "run record", MAX_RUN_RECORD_BYTES);
  } catch {
    throw new PaperbotError(
      `agent run directory is not available: ${runPath}`,
      ExitCode.io,
    );
  }
  return securedRunPath;
}

async function readRunRecord(runPath: string): Promise<AgentRunRecord> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readArtifact(
        artifactPath(runPath, "run.json"),
        "run record",
        MAX_RUN_RECORD_BYTES,
      ),
    ) as unknown;
  } catch {
    throw new PaperbotError(
      `could not read agent run record: ${runPath}`,
      ExitCode.io,
    );
  }
  if (!isRunRecord(value)) {
    throw new PaperbotError(
      `agent run record is invalid: ${runPath}`,
      ExitCode.io,
    );
  }
  return value;
}

function isRunRecord(value: unknown): value is AgentRunRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "schema_version" in value &&
    value.schema_version === "1" &&
    "input" in value &&
    typeof value.input === "object" &&
    value.input !== null &&
    "agent" in value &&
    typeof value.agent === "object" &&
    value.agent !== null &&
    "artifacts" in value &&
    typeof value.artifacts === "object" &&
    value.artifacts !== null
  );
}

async function readArtifact(
  path: string,
  label: string,
  maximumBytes: number,
): Promise<string> {
  let content: Buffer;
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > maximumBytes
    ) {
      throw new Error("unsafe artifact");
    }
    content = await readFile(path);
  } catch {
    throw new PaperbotError(`could not read ${label}: ${path}`, ExitCode.io);
  }
  if (content.byteLength > maximumBytes) {
    throw new PaperbotError(
      `${label} exceeds its size limit: ${path}`,
      ExitCode.io,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new PaperbotError(
      `${label} is not valid UTF-8: ${path}`,
      ExitCode.io,
    );
  }
}

function draftFromPaper(paper: string): DraftResponse {
  const bodyStart = paper.indexOf("\n---\n");
  if (bodyStart === -1) {
    throw new PaperbotError("agent draft is missing front matter", ExitCode.io);
  }
  const markdown = paper
    .slice(bodyStart + "\n---\n".length)
    .replace(
      /^\s*> \*\*Private research draft\.\*\*[\s\S]*?publication rights before submitting it\.\n\n/,
      "",
    );
  return {
    summary: "Existing draft summary is retained in front matter.",
    topics: ["research_draft"],
    markdown,
    evidence: [],
    questions: [],
  };
}

async function readReviewArtifact(
  runPath: string,
  allowedSourceIds: ReadonlySet<string>,
): Promise<ReviewResponse> {
  let artifact: unknown;
  try {
    artifact = JSON.parse(
      await readArtifact(
        artifactPath(runPath, "review.json"),
        "review",
        MAX_REVIEW_BYTES,
      ),
    );
  } catch {
    throw invalidReviewArtifact(runPath);
  }
  if (!isStoredReviewArtifact(artifact)) {
    throw invalidReviewArtifact(runPath);
  }
  try {
    const review = parseReviewResponse(JSON.stringify(artifact));
    validateReviewSourceIds(review, allowedSourceIds);
    return review;
  } catch {
    throw invalidReviewArtifact(runPath);
  }
}

function assertRestoredSourceMatchesRunRecord(
  source: AgentSource,
  record: AgentRunRecord,
  runPath: string,
): void {
  const recorded = readRunSourceRecord(record.source, runPath);
  const canonicalUrl = normalizeStoredSourceUrl(
    source.canonical_url,
    "source canonical_url",
    runPath,
  );
  const scanSourceUrl = normalizeStoredSourceUrl(
    source.scan_manifest.repository.source_url,
    "scan source_url",
    runPath,
  );

  if (
    recorded.kind !== source.kind ||
    recorded.canonical_url !== canonicalUrl ||
    recorded.scan_source_url !== scanSourceUrl ||
    recorded.resolved_revision !== source.resolved_revision ||
    recorded.is_dirty !== source.is_dirty ||
    recorded.retrieved_at !== source.retrieved_at
  ) {
    throw new PaperbotError(
      `agent source artifact does not match its run record: ${runPath}`,
      ExitCode.io,
    );
  }
}

function readRunSourceRecord(
  value: unknown,
  runPath: string,
): AgentRunSourceRecord {
  if (!isRecord(value)) {
    throw new PaperbotError(
      `agent run record is missing source metadata: ${runPath}`,
      ExitCode.io,
    );
  }
  if (
    (value.kind !== "github" && value.kind !== "local") ||
    typeof value.resolved_revision !== "string" ||
    !SHA_PATTERN.test(value.resolved_revision) ||
    typeof value.is_dirty !== "boolean" ||
    typeof value.retrieved_at !== "string"
  ) {
    throw new PaperbotError(
      `agent run record has invalid source metadata: ${runPath}`,
      ExitCode.io,
    );
  }
  const retrievedAt = readStoredTimestamp(value.retrieved_at, runPath);
  return {
    kind: value.kind,
    ...(value.canonical_url === undefined
      ? {}
      : {
          canonical_url: normalizeStoredSourceUrl(
            value.canonical_url,
            "run record canonical_url",
            runPath,
          ),
        }),
    ...(value.scan_source_url === undefined
      ? {}
      : {
          scan_source_url: normalizeStoredSourceUrl(
            value.scan_source_url,
            "run record scan_source_url",
            runPath,
          ),
        }),
    resolved_revision: value.resolved_revision.toLowerCase(),
    is_dirty: value.is_dirty,
    retrieved_at: retrievedAt,
  };
}

function normalizeStoredSourceUrl(
  value: unknown,
  label: string,
  runPath: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return normalizeAnonymousHttpUrl(value, label);
  } catch {
    throw new PaperbotError(
      `agent run source metadata has an invalid ${label}: ${runPath}`,
      ExitCode.io,
    );
  }
}

function readStoredTimestamp(value: string, runPath: string): string {
  if (value.length > 64 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PaperbotError(
      `agent run record has invalid source metadata: ${runPath}`,
      ExitCode.io,
    );
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) {
    throw new PaperbotError(
      `agent run record has invalid source metadata: ${runPath}`,
      ExitCode.io,
    );
  }
  return timestamp.toISOString();
}

function isStoredReviewArtifact(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.schema_version === "1" &&
    typeof value.reviewed_at === "string" &&
    value.reviewed_at.length <= 64 &&
    !/[\u0000-\u001f\u007f]/.test(value.reviewed_at) &&
    !Number.isNaN(new Date(value.reviewed_at).valueOf())
  );
}

function invalidReviewArtifact(runPath: string): PaperbotError {
  return new PaperbotError(
    `agent review artifact is invalid: ${runPath}`,
    ExitCode.io,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function nextProposalName(runPath: string): Promise<string> {
  for (let index = 1; index < 1_000; index += 1) {
    const filename = `proposal-${index}.md`;
    try {
      await readFile(artifactPath(runPath, filename), "utf8");
    } catch {
      return filename;
    }
  }
  throw new PaperbotError(
    "agent run already has too many proposals",
    ExitCode.io,
  );
}
