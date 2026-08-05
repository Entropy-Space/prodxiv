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
  initializeRunDirectory,
  sha256,
  writeJsonArtifact,
  writeTextArtifact,
} from "./artifacts.ts";
import {
  appendAuthorEvidence,
  buildValidatedEvidence,
  evidenceIds,
  formatEvidenceJsonLines,
  parseStoredEvidence,
  type AuthorEvidenceSource,
} from "./evidence.ts";
import {
  normalizeAgentMetadata,
  normalizeAnonymousHttpUrl,
  normalizeExternalSources,
  normalizeModelName,
} from "./input.ts";
import { redactModelSecrets } from "./model-config.ts";
import {
  assessDraft,
  draftFromPaper,
  emptyDraftResponse,
  type DraftAssessment,
} from "./paper.ts";
import { PiAuthoringRuntime } from "./pi.ts";
import {
  createAnswersPrompt,
  createDraftCorrectionPrompt,
  createDraftPrompt,
  createEvidenceCorrectionPrompt,
  createEvidencePrompt,
  createSelfReviewPrompt,
} from "./prompts.ts";
import {
  parseAuthoringResponse,
  parseDraftResponse,
  parseEvidenceResponse,
  validateAuthoringEvidenceIds,
  validateConflictSourceIds,
  validateEvidenceCandidateSourceIds,
} from "./responses.ts";
import {
  assertRestoredSourceMatchesRunRecord,
  assertResumableRecord,
  createRunRecord,
  MAX_AUTHOR_ANSWERS_BYTES,
  MAX_AUTHOR_QUESTION_ROUNDS,
  MAX_EVIDENCE_BYTES,
  pendingQuestionsFor,
  persistRunRecord,
  readArtifact,
  readAuthorEvidenceSources,
  readCurrentDraft,
  readEvidenceAnalysis,
  readQuestions,
  readQuestionsIfPresent,
  readRequiredArtifact,
  readRunRecord,
  relativeArtifact,
  requiredSessionRecord,
  resolveExistingRun,
  sourceRecord,
  writeQuestionsArtifacts,
  type StoredEvidenceAnalysis,
} from "./run-store.ts";
import {
  captureSessionArtifact,
  verifySessionArtifact,
} from "./session-store.ts";
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
  AgentSessionRole,
  AgentSource,
  AskQuestionsResponse,
  AuthoringResponse,
  AuthoringRuntime,
  AuthoringSession,
  AuthorQuestion,
  EvidenceItem,
} from "./types.ts";

const MAX_EVIDENCE_REPAIR_ATTEMPTS = 1;
const MAX_DRAFT_REPAIR_ATTEMPTS = 2;
const MAX_EVIDENCE_SESSION_TURNS = 4;
const MAX_AUTHOR_SESSION_TURNS = 12;

export { MAX_AUTHOR_QUESTION_ROUNDS } from "./run-store.ts";
export { renderPaper } from "./paper.ts";

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
  let record = createRunRecord(
    { ...options, metadata: requestedMetadata },
    model,
    externalSources,
    now(dependencies).toISOString(),
  );
  let evidenceSession: AuthoringSession | undefined;
  let authorSession: AuthoringSession | undefined;
  await persistRunRecord(runPath, record);

  try {
    const source = await acquireSource(options, dependencies);
    const metadata = completeMetadata(requestedMetadata, source);
    const sourceArtifacts = await writeSourceArtifacts(runPath, source);
    record.input.metadata = metadata;
    record.state = "inputs_ready";
    record.source = sourceRecord(source);
    record.artifacts.source = relativeArtifact(
      runPath,
      sourceArtifacts.source_path,
    );
    record.artifacts.scan = relativeArtifact(
      runPath,
      sourceArtifacts.scan_path,
    );
    record.updated_at = now(dependencies).toISOString();
    await persistRunRecord(runPath, record);

    const runtime = runtimeFor(model, dependencies);
    evidenceSession = await runtime.startSession({
      role: "evidence",
      run_path: runPath,
    });
    const { analysis, evidence } = await produceEvidence({
      runtime_session: evidenceSession,
      source,
      metadata,
      external_sources: externalSources,
      run_path: runPath,
      record,
      dependencies,
    });
    await evidenceSession.dispose();
    evidenceSession = undefined;

    authorSession = await runtime.startSession({
      role: "author",
      run_path: runPath,
    });
    record.state = "authoring";
    record.workflow.author_phase = "drafting";
    record.updated_at = now(dependencies).toISOString();
    await persistRunRecord(runPath, record);

    const initialDraft = await parseWithOneRetry(
      authorSession,
      "author",
      createDraftPrompt({
        source,
        metadata,
        external_sources: externalSources,
        evidence,
        analysis,
      }),
      runPath,
      record,
      dependencies,
      parseDraftResponse,
      "initial draft",
    );
    const initialResolution = await resolveDraftResponse({
      initial_response: initialDraft,
      allow_questions: false,
      session: authorSession,
      source,
      metadata,
      external_sources: externalSources,
      evidence,
      run_path: runPath,
      record,
      dependencies,
    });
    if (initialResolution.action === "ask_questions") {
      throw new PaperbotError(
        "authoring session asked questions before producing its first draft",
        ExitCode.validation,
      );
    }
    await checkpointDraft(runPath, record, initialResolution, dependencies);

    const reviewResponse = await parseWithOneRetry(
      authorSession,
      "author",
      createSelfReviewPrompt({
        source,
        metadata,
        external_sources: externalSources,
        evidence,
        analysis,
        draft: initialResolution.draft,
        remaining_question_rounds: remainingQuestionRounds(record),
      }),
      runPath,
      record,
      dependencies,
      parseAuthoringResponse,
      "draft review",
    );
    const reviewResolution = await resolveDraftResponse({
      initial_response: reviewResponse,
      allow_questions: remainingQuestionRounds(record) > 0,
      session: authorSession,
      source,
      metadata,
      external_sources: externalSources,
      evidence,
      run_path: runPath,
      record,
      dependencies,
    });
    if (reviewResolution.action === "ask_questions") {
      await checkpointQuestions(
        runPath,
        record,
        reviewResolution,
        [],
        dependencies,
      );
      return runResult(runPath, record, initialResolution.validation, source);
    }

    await checkpointDraft(runPath, record, reviewResolution, dependencies);
    await finalizePaper(runPath, record, reviewResolution, dependencies);
    return runResult(runPath, record, reviewResolution.validation, source);
  } catch (error) {
    record.state = "failed";
    record.updated_at = now(dependencies).toISOString();
    record.error = { message: safeErrorMessage(error) };
    await persistRunRecord(runPath, record).catch(() => undefined);
    throw error;
  } finally {
    await evidenceSession?.dispose();
    await authorSession?.dispose();
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
  assertResumableRecord(record, runPath);
  const metadata = normalizeAgentMetadata(record.input.metadata);
  const externalSources = normalizeExternalSources(
    record.input.external_sources,
  );
  const source = await readSourceArtifact(runPath);
  assertRestoredSourceMatchesRunRecord(source, record, runPath);
  const analysis = await readEvidenceAnalysis(runPath, source, record);
  const authorSources = await readAuthorEvidenceSources(runPath, record);
  let evidence = parseStoredEvidence(
    await readRequiredArtifact(
      runPath,
      record.artifacts.evidence,
      "evidence",
      MAX_EVIDENCE_BYTES,
    ),
    source,
    authorSources,
  );
  const questionHistory = await readQuestions(runPath, record, evidence);
  const pendingQuestions = pendingQuestionsFor(record, questionHistory);
  const answers = await readArtifact(
    options.answers_path,
    "answers",
    MAX_AUTHOR_ANSWERS_BYTES,
  );
  const currentPaper = await readCurrentDraft(runPath, record);
  const currentDraft = draftFromPaper(currentPaper, evidence);
  const answerRound = record.workflow.question_rounds;
  const answerArtifact = `answers/round-${answerRound}.md`;
  if (record.artifacts.answers?.includes(answerArtifact)) {
    const storedAnswers = await readArtifact(
      artifactPath(runPath, answerArtifact),
      "stored answers",
      MAX_AUTHOR_ANSWERS_BYTES,
    );
    if (storedAnswers !== answers) {
      throw new PaperbotError(
        `author answers for round ${answerRound} were already recorded`,
        ExitCode.io,
      );
    }
  } else {
    await writeTextArtifact(runPath, answerArtifact, answers);
    record.artifacts.answers = [
      ...(record.artifacts.answers ?? []),
      answerArtifact,
    ];
  }
  const authorSource: AuthorEvidenceSource = {
    source_id: `author:answers:round-${answerRound}`,
    path: answerArtifact,
    content: answers,
  };
  if (!evidence.some((item) => item.source_id === authorSource.source_id)) {
    evidence = appendAuthorEvidence(evidence, authorSource, answerRound);
    await writeTextArtifact(
      runPath,
      "evidence.jsonl",
      formatEvidenceJsonLines(evidence),
    );
  }
  record.state = "authoring";
  record.updated_at = now(dependencies).toISOString();
  delete record.error;
  await persistRunRecord(runPath, record);

  const runtime = runtimeFor(
    normalizeModelName(options.model ?? record.agent.model),
    dependencies,
  );
  let authorSession: AuthoringSession | undefined;
  try {
    const storedSession = requiredSessionRecord(record, "author", runPath);
    const sessionPath = await verifySessionArtifact(
      runPath,
      "author",
      storedSession,
    );
    authorSession = await runtime.startSession({
      role: "author",
      run_path: runPath,
      session_id: storedSession.session_id,
      session_path: sessionPath,
    });
    const response = await parseWithOneRetry(
      authorSession,
      "author",
      createAnswersPrompt({
        source,
        metadata,
        external_sources: externalSources,
        evidence,
        analysis,
        draft: currentDraft,
        questions: pendingQuestions,
        answers,
        remaining_question_rounds: remainingQuestionRounds(record),
      }),
      runPath,
      record,
      dependencies,
      parseAuthoringResponse,
      "author-guided revision",
    );
    const resolution = await resolveDraftResponse({
      initial_response: response,
      allow_questions: remainingQuestionRounds(record) > 0,
      session: authorSession,
      source,
      metadata,
      external_sources: externalSources,
      evidence,
      run_path: runPath,
      record,
      dependencies,
    });
    if (resolution.action === "ask_questions") {
      const currentValidation = validatePaperSource(
        currentPaper,
        artifactPath(runPath, record.workflow.current_draft ?? "draft.md"),
        "draft",
      );
      await checkpointQuestions(
        runPath,
        record,
        resolution,
        questionHistory,
        dependencies,
      );
      return runResult(runPath, record, currentValidation, source);
    }
    await checkpointDraft(runPath, record, resolution, dependencies);
    await finalizePaper(runPath, record, resolution, dependencies);
    return runResult(runPath, record, resolution.validation, source);
  } catch (error) {
    record.state = "failed";
    record.updated_at = now(dependencies).toISOString();
    record.error = { message: safeErrorMessage(error) };
    await persistRunRecord(runPath, record).catch(() => undefined);
    throw error;
  } finally {
    await authorSession?.dispose();
  }
}

async function produceEvidence(input: {
  runtime_session: AuthoringSession;
  source: AgentSource;
  metadata: AgentPaperMetadata;
  external_sources: string[];
  run_path: string;
  record: AgentRunRecord;
  dependencies: AgentRunnerDependencies;
}): Promise<{ analysis: StoredEvidenceAnalysis; evidence: EvidenceItem[] }> {
  let response = await parseWithOneRetry(
    input.runtime_session,
    "evidence",
    createEvidencePrompt(input),
    input.run_path,
    input.record,
    input.dependencies,
    parseEvidenceResponse,
    "evidence analysis",
  );
  for (let attempt = 0; attempt <= MAX_EVIDENCE_REPAIR_ATTEMPTS; attempt += 1) {
    const candidateArtifact = `evidence-candidates/candidate-${attempt + 1}.json`;
    await writeJsonArtifact(input.run_path, candidateArtifact, {
      schema_version: "1",
      ...response,
    });
    input.record.state = "evidence_ready";
    input.record.artifacts.evidence_candidates = candidateArtifact;
    input.record.updated_at = now(input.dependencies).toISOString();
    await persistRunRecord(input.run_path, input.record);
    try {
      const allowedSourceIds = availableSourceIds(input.source);
      validateEvidenceCandidateSourceIds(response.evidence, allowedSourceIds);
      validateConflictSourceIds(response.contradictions, allowedSourceIds);
      const evidence = buildValidatedEvidence(response.evidence, input.source);
      const analysis: StoredEvidenceAnalysis = {
        schema_version: "1",
        contradictions: response.contradictions,
        unknowns: response.unknowns,
        questions: response.questions,
      };
      await writeTextArtifact(
        input.run_path,
        "evidence.jsonl",
        formatEvidenceJsonLines(evidence),
      );
      await writeJsonArtifact(
        input.run_path,
        "evidence-analysis.json",
        analysis,
      );
      input.record.state = "evidence_validated";
      input.record.artifacts.evidence = "evidence.jsonl";
      input.record.artifacts.evidence_analysis = "evidence-analysis.json";
      input.record.updated_at = now(input.dependencies).toISOString();
      await persistRunRecord(input.run_path, input.record);
      return { analysis, evidence };
    } catch (error) {
      if (
        attempt >= MAX_EVIDENCE_REPAIR_ATTEMPTS ||
        !(error instanceof PaperbotError) ||
        error.exit_code !== ExitCode.validation
      ) {
        throw error;
      }
      response = await parseWithOneRetry(
        input.runtime_session,
        "evidence",
        createEvidenceCorrectionPrompt({ diagnostics: [error.message] }),
        input.run_path,
        input.record,
        input.dependencies,
        parseEvidenceResponse,
        "corrected evidence analysis",
      );
    }
  }
  throw new PaperbotError(
    "evidence analysis exhausted its repair limit",
    ExitCode.validation,
  );
}

async function resolveDraftResponse(input: {
  initial_response: AuthoringResponse;
  allow_questions: boolean;
  session: AuthoringSession;
  source: AgentSource;
  metadata: AgentPaperMetadata;
  external_sources: string[];
  evidence: EvidenceItem[];
  run_path: string;
  record: AgentRunRecord;
  dependencies: AgentRunnerDependencies;
}): Promise<AskQuestionsResponse | DraftAssessment> {
  let response = input.initial_response;
  for (let attempt = 0; attempt <= MAX_DRAFT_REPAIR_ATTEMPTS; attempt += 1) {
    try {
      validateAuthoringEvidenceIds(response, evidenceIds(input.evidence));
    } catch (error) {
      if (!(error instanceof PaperbotError)) {
        throw error;
      }
      if (attempt >= MAX_DRAFT_REPAIR_ATTEMPTS) {
        throw error;
      }
      input.record.workflow.repair_attempts = attempt + 1;
      response = await parseWithOneRetry(
        input.session,
        "author",
        createDraftCorrectionPrompt({
          draft:
            response.action === "submit_draft"
              ? response
              : emptyDraftResponse(input.evidence),
          diagnostics: [error.message],
          remaining_question_rounds: input.allow_questions
            ? remainingQuestionRounds(input.record)
            : 0,
        }),
        input.run_path,
        input.record,
        input.dependencies,
        input.allow_questions ? parseAuthoringResponse : parseDraftResponse,
        "evidence-bound draft correction",
      );
      continue;
    }
    if (response.action === "ask_questions") {
      if (input.allow_questions) {
        input.record.workflow.repair_attempts = 0;
        return response;
      }
      if (attempt >= MAX_DRAFT_REPAIR_ATTEMPTS) {
        throw new PaperbotError(
          "authoring session exceeded the question-round limit",
          ExitCode.validation,
        );
      }
      input.record.workflow.repair_attempts = attempt + 1;
      response = await parseWithOneRetry(
        input.session,
        "author",
        createDraftCorrectionPrompt({
          draft: emptyDraftResponse(input.evidence),
          diagnostics: [
            "A full draft is required now; no author-question round is available in this phase.",
          ],
          remaining_question_rounds: 0,
        }),
        input.run_path,
        input.record,
        input.dependencies,
        parseDraftResponse,
        "required draft correction",
      );
      continue;
    }
    const assessment = assessDraft(
      input.metadata,
      input.external_sources,
      input.evidence,
      input.run_path,
      response,
    );
    if (assessment.diagnostics.length === 0) {
      input.record.workflow.repair_attempts = 0;
      return assessment;
    }
    if (attempt >= MAX_DRAFT_REPAIR_ATTEMPTS) {
      throw invalidDraftError(assessment.diagnostics);
    }
    input.record.workflow.repair_attempts = attempt + 1;
    response = await parseWithOneRetry(
      input.session,
      "author",
      createDraftCorrectionPrompt({
        draft: response,
        diagnostics: assessment.diagnostics,
        remaining_question_rounds: input.allow_questions
          ? remainingQuestionRounds(input.record)
          : 0,
      }),
      input.run_path,
      input.record,
      input.dependencies,
      input.allow_questions ? parseAuthoringResponse : parseDraftResponse,
      "draft correction",
    );
  }
  throw new PaperbotError(
    "authoring session exhausted its repair limit",
    ExitCode.validation,
  );
}

async function checkpointDraft(
  runPath: string,
  record: AgentRunRecord,
  assessment: DraftAssessment,
  dependencies: AgentRunnerDependencies,
): Promise<void> {
  const revision = record.workflow.draft_revision + 1;
  const markdownArtifact = `drafts/draft-${revision}.md`;
  const responseArtifact = `drafts/draft-${revision}.json`;
  const validationArtifact = `drafts/draft-${revision}.validation.json`;
  await writeTextArtifact(runPath, markdownArtifact, assessment.paper);
  await writeJsonArtifact(runPath, responseArtifact, assessment.draft);
  await writeJsonArtifact(
    runPath,
    validationArtifact,
    assessment.validation.report,
  );
  await writeJsonArtifact(
    runPath,
    "validation.json",
    assessment.validation.report,
  );
  if (revision === 1) {
    await writeTextArtifact(runPath, "draft.md", assessment.paper);
    record.artifacts.draft = "draft.md";
  }
  record.artifacts.drafts = [
    ...(record.artifacts.drafts ?? []),
    markdownArtifact,
  ];
  record.artifacts.validation = "validation.json";
  record.workflow.current_draft = markdownArtifact;
  record.workflow.draft_revision = revision;
  record.workflow.author_phase = "reviewing";
  record.workflow.repair_attempts = 0;
  record.draft_sha256 = sha256(assessment.paper);
  record.state = "authoring";
  record.updated_at = now(dependencies).toISOString();
  await persistRunRecord(runPath, record);
}

async function checkpointQuestions(
  runPath: string,
  record: AgentRunRecord,
  response: AskQuestionsResponse,
  history: AuthorQuestion[],
  dependencies: AgentRunnerDependencies,
): Promise<void> {
  if (remainingQuestionRounds(record) <= 0) {
    throw new PaperbotError(
      `agent author questions are limited to ${MAX_AUTHOR_QUESTION_ROUNDS} rounds`,
      ExitCode.validation,
    );
  }
  const round = record.workflow.question_rounds + 1;
  const nextIndex = history.length + 1;
  const questions = response.questions.map((question, index) => ({
    question_id: `question:${(nextIndex + index).toString().padStart(3, "0")}`,
    ...question,
  }));
  const allQuestions = [...history, ...questions];
  await writeQuestionsArtifacts(
    runPath,
    allQuestions,
    new Set(questions.map((question) => question.question_id)),
    [],
  );
  record.state = "awaiting_author";
  record.workflow.question_rounds = round;
  record.workflow.pending_question_ids = questions.map(
    (question) => question.question_id,
  );
  record.artifacts.questions = "questions.jsonl";
  record.updated_at = now(dependencies).toISOString();
  await persistRunRecord(runPath, record);
}

async function finalizePaper(
  runPath: string,
  record: AgentRunRecord,
  assessment: DraftAssessment,
  dependencies: AgentRunnerDependencies,
): Promise<void> {
  const questionHistory = await readQuestionsIfPresent(runPath, record);
  await writeTextArtifact(runPath, "paper.md", assessment.paper);
  await writeQuestionsArtifacts(
    runPath,
    questionHistory,
    new Set(),
    assessment.draft.unresolved_questions,
  );
  record.state = "needs_author_review";
  record.workflow.pending_question_ids = [];
  record.artifacts.paper = "paper.md";
  record.artifacts.questions = "questions.jsonl";
  record.paper_sha256 = sha256(assessment.paper);
  record.updated_at = now(dependencies).toISOString();
  await persistRunRecord(runPath, record);
}

async function parseWithOneRetry<T>(
  session: AuthoringSession,
  role: AgentSessionRole,
  prompt: string,
  runPath: string,
  record: AgentRunRecord,
  dependencies: AgentRunnerDependencies,
  parser: (value: string) => T,
  operation: string,
): Promise<T> {
  let response = await completeModelTurn(
    session,
    role,
    prompt,
    runPath,
    record,
    dependencies,
  );
  try {
    return parser(response);
  } catch (firstError) {
    if (!(firstError instanceof PaperbotError)) {
      throw firstError;
    }
    response = await completeModelTurn(
      session,
      role,
      [
        `Your previous ${operation} response could not be parsed: ${firstError.message}`,
        "Return exactly one valid fenced JSON object in the shape requested by the previous turn, with no prose outside it.",
      ].join("\n\n"),
      runPath,
      record,
      dependencies,
    );
    return parser(response);
  }
}

async function completeModelTurn(
  session: AuthoringSession,
  role: AgentSessionRole,
  prompt: string,
  runPath: string,
  record: AgentRunRecord,
  dependencies: AgentRunnerDependencies,
): Promise<string> {
  const currentTurns = record.sessions[role]?.turn_count ?? 0;
  const maximumTurns =
    role === "evidence" ? MAX_EVIDENCE_SESSION_TURNS : MAX_AUTHOR_SESSION_TURNS;
  if (currentTurns >= maximumTurns) {
    throw new PaperbotError(
      `${role} session exceeded its ${maximumTurns}-turn limit`,
      ExitCode.validation,
    );
  }
  let completion;
  try {
    completion = await session.complete({ prompt });
  } catch (error) {
    // Pi may persist the user turn before a provider failure. Keep the host's
    // digest and turn counter aligned with that durable session so a retry is
    // not mistaken for artifact tampering.
    await checkpointSession(
      runPath,
      record,
      role,
      session,
      currentTurns + 1,
      dependencies,
    );
    throw error;
  }
  await checkpointSession(
    runPath,
    record,
    role,
    session,
    currentTurns + 1,
    dependencies,
  );
  return completion.final_text;
}

async function checkpointSession(
  runPath: string,
  record: AgentRunRecord,
  role: AgentSessionRole,
  session: AuthoringSession,
  turnCount: number,
  dependencies: AgentRunnerDependencies,
): Promise<void> {
  const snapshot = session.snapshot();
  const existing = record.sessions[role];
  if (existing !== undefined && existing.session_id !== snapshot.session_id) {
    throw new PaperbotError(
      `${role} session ID changed during the Paperbot run`,
      ExitCode.io,
    );
  }
  const artifact = await captureSessionArtifact(runPath, role, snapshot);
  record.sessions[role] = {
    ...artifact,
    turn_count: turnCount,
  };
  record.updated_at = now(dependencies).toISOString();
  await persistRunRecord(runPath, record);
}

function invalidDraftError(diagnostics: string[]): PaperbotError {
  return new PaperbotError(
    `agent returned an invalid draft after ${MAX_DRAFT_REPAIR_ATTEMPTS} repair attempts: ${diagnostics.join("; ")}`,
    ExitCode.validation,
  );
}

function availableSourceIds(source: AgentSource): Set<string> {
  return new Set(source.files.map((file) => file.source_id));
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

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactModelSecrets(message);
}

function remainingQuestionRounds(record: AgentRunRecord): number {
  return MAX_AUTHOR_QUESTION_ROUNDS - record.workflow.question_rounds;
}

function runResult(
  runPath: string,
  record: AgentRunRecord,
  validation: PaperValidationResult,
  source: AgentSource,
): AgentRunResult {
  return {
    run_path: runPath,
    state: record.state,
    validation: {
      valid: validation.report.valid,
      diagnostics: validation.report.diagnostics.length,
    },
    questions: {
      pending: record.workflow.pending_question_ids.length,
      round: record.workflow.question_rounds,
    },
    source: {
      resolved_revision: source.resolved_revision,
      selected_file_count: source.files.length,
    },
  };
}
