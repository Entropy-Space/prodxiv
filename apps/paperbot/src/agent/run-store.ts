import { lstat, readFile } from "node:fs/promises";

import { ExitCode, PaperbotError } from "@prodxiv/paperbot-core";
import {
  artifactPath,
  ensureRunDirectory,
  sha256,
  writeJsonArtifact,
  writeTextArtifact,
} from "./artifacts.ts";
import { evidenceIds, type AuthorEvidenceSource } from "./evidence.ts";
import { normalizeAnonymousHttpUrl } from "./input.ts";
import {
  parseEvidenceResponse,
  validateConflictSourceIds,
} from "./responses.ts";
import type {
  AgentPaperMetadata,
  AgentRunRecord,
  AgentRunSourceRecord,
  AgentSessionRecord,
  AgentSessionRole,
  AgentSource,
  AuthorQuestion,
  EvidenceItem,
  EvidenceResponse,
} from "./types.ts";

export const MAX_AUTHOR_ANSWERS_BYTES = 32 * 1024;
export const MAX_EVIDENCE_BYTES = 512 * 1024;
export const MAX_AUTHOR_QUESTION_ROUNDS = 3;

const MAX_RESUME_DRAFT_BYTES = 256 * 1024;
const MAX_RUN_RECORD_BYTES = 128 * 1024;
const MAX_ANALYSIS_BYTES = 128 * 1024;
const MAX_QUESTIONS_BYTES = 128 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export interface StoredEvidenceAnalysis {
  schema_version: "1";
  contradictions: EvidenceResponse["contradictions"];
  unknowns: string[];
  questions: string[];
}

export function createRunRecord(
  options: { repository: string; metadata: AgentPaperMetadata },
  model: string,
  externalSources: string[],
  timestamp: string,
): AgentRunRecord {
  return {
    schema_version: "2",
    state: "initialized",
    started_at: timestamp,
    updated_at: timestamp,
    agent: { provider: "pi", model },
    input: {
      repository: options.repository,
      allow_remote_model: true,
      external_sources: externalSources,
      metadata: options.metadata,
    },
    sessions: {},
    workflow: {
      author_phase: "drafting",
      question_rounds: 0,
      draft_revision: 0,
      repair_attempts: 0,
      pending_question_ids: [],
    },
    artifacts: {},
  };
}

export function sourceRecord(source: AgentSource): AgentRunSourceRecord {
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

export async function persistRunRecord(
  runPath: string,
  record: AgentRunRecord,
): Promise<void> {
  await writeJsonArtifact(runPath, "run.json", record);
}

export function relativeArtifact(runPath: string, artifact: string): string {
  const prefix = `${runPath}/`;
  return artifact.startsWith(prefix) ? artifact.slice(prefix.length) : artifact;
}

export async function resolveExistingRun(runPath: string): Promise<string> {
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

export async function readRunRecord(runPath: string): Promise<AgentRunRecord> {
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
    throw invalidRunRecord(runPath);
  }
  if (!isRunRecord(value)) {
    throw invalidRunRecord(runPath);
  }
  return value;
}

export async function readArtifact(
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

export async function readRequiredArtifact(
  runPath: string,
  relativePath: string | undefined,
  label: string,
  maximumBytes: number,
): Promise<string> {
  if (relativePath === undefined) {
    throw new PaperbotError(
      `agent run is missing its ${label} artifact: ${runPath}`,
      ExitCode.io,
    );
  }
  return readArtifact(artifactPath(runPath, relativePath), label, maximumBytes);
}

export async function readEvidenceAnalysis(
  runPath: string,
  source: AgentSource,
  record: AgentRunRecord,
): Promise<StoredEvidenceAnalysis> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readRequiredArtifact(
        runPath,
        record.artifacts.evidence_analysis,
        "evidence analysis",
        MAX_ANALYSIS_BYTES,
      ),
    ) as unknown;
  } catch {
    throw invalidEvidenceAnalysis(runPath);
  }
  if (!isRecord(value) || value.schema_version !== "1") {
    throw invalidEvidenceAnalysis(runPath);
  }
  try {
    const parsed = parseEvidenceResponse(
      JSON.stringify({
        evidence: [],
        contradictions: value.contradictions,
        unknowns: value.unknowns,
        questions: value.questions,
      }),
    );
    validateConflictSourceIds(
      parsed.contradictions,
      new Set(source.files.map((file) => file.source_id)),
    );
    return {
      schema_version: "1",
      contradictions: parsed.contradictions,
      unknowns: parsed.unknowns,
      questions: parsed.questions,
    };
  } catch {
    throw invalidEvidenceAnalysis(runPath);
  }
}

export async function readAuthorEvidenceSources(
  runPath: string,
  record: AgentRunRecord,
): Promise<Map<string, AuthorEvidenceSource>> {
  const sources = new Map<string, AuthorEvidenceSource>();
  for (const [index, path] of (record.artifacts.answers ?? []).entries()) {
    const round = index + 1;
    if (path !== `answers/round-${round}.md`) {
      throw new PaperbotError(
        `agent answers artifact list is invalid: ${runPath}`,
        ExitCode.io,
      );
    }
    const source = {
      source_id: `author:answers:round-${round}`,
      path,
      content: await readArtifact(
        artifactPath(runPath, path),
        "stored answers",
        MAX_AUTHOR_ANSWERS_BYTES,
      ),
    };
    sources.set(source.source_id, source);
  }
  return sources;
}

export async function readQuestions(
  runPath: string,
  record: AgentRunRecord,
  evidence: EvidenceItem[],
): Promise<AuthorQuestion[]> {
  const serialized = await readRequiredArtifact(
    runPath,
    record.artifacts.questions,
    "questions",
    MAX_QUESTIONS_BYTES,
  );
  const questions = parseQuestionLines(serialized, runPath);
  const allowedEvidenceIds = evidenceIds(evidence);
  for (const question of questions) {
    if (
      question.evidence_ids.some(
        (evidenceId) => !allowedEvidenceIds.has(evidenceId),
      )
    ) {
      throw invalidQuestions(runPath);
    }
  }
  return questions;
}

export async function readQuestionsIfPresent(
  runPath: string,
  record: AgentRunRecord,
): Promise<AuthorQuestion[]> {
  if (record.artifacts.questions === undefined) {
    return [];
  }
  const serialized = await readArtifact(
    artifactPath(runPath, record.artifacts.questions),
    "questions",
    MAX_QUESTIONS_BYTES,
  );
  return parseQuestionLines(serialized, runPath);
}

export async function writeQuestionsArtifacts(
  runPath: string,
  questions: AuthorQuestion[],
  pendingIds: ReadonlySet<string>,
  unresolvedQuestions: string[],
): Promise<void> {
  await writeTextArtifact(
    runPath,
    "questions.jsonl",
    questions.map((question) => JSON.stringify(question)).join("\n") +
      (questions.length === 0 ? "" : "\n"),
  );
  const pending = questions.filter((question) =>
    pendingIds.has(question.question_id),
  );
  const previous = questions.filter(
    (question) => !pendingIds.has(question.question_id),
  );
  await writeTextArtifact(
    runPath,
    "questions.md",
    [
      "# Author Questions",
      "",
      "These questions mark information the validated evidence cannot establish.",
      "",
      ...(pending.length === 0
        ? []
        : [
            "## Pending",
            "",
            ...pending.map(
              (question, index) =>
                `${index + 1}. ${question.question}\n   - Why: ${question.reason}\n   - ID: \`${question.question_id}\``,
            ),
            "",
          ]),
      ...(previous.length === 0
        ? []
        : [
            "## Previous rounds",
            "",
            ...previous.map(
              (question, index) =>
                `${index + 1}. ${question.question} (\`${question.question_id}\`)`,
            ),
            "",
          ]),
      ...(unresolvedQuestions.length === 0
        ? []
        : [
            "## Unresolved in the current paper",
            "",
            ...unresolvedQuestions.map(
              (question, index) => `${index + 1}. ${question}`,
            ),
            "",
          ]),
      ...(pending.length === 0 &&
      previous.length === 0 &&
      unresolvedQuestions.length === 0
        ? [
            "No questions were generated; author review is still required before submission.",
            "",
          ]
        : []),
    ].join("\n"),
  );
}

export function pendingQuestionsFor(
  record: AgentRunRecord,
  questions: AuthorQuestion[],
): AuthorQuestion[] {
  const pendingIds = new Set(record.workflow.pending_question_ids);
  const pending = questions.filter((question) =>
    pendingIds.has(question.question_id),
  );
  if (pending.length !== pendingIds.size || pending.length === 0) {
    throw new PaperbotError(
      "agent run does not contain a complete pending question round",
      ExitCode.io,
    );
  }
  return pending;
}

export async function readCurrentDraft(
  runPath: string,
  record: AgentRunRecord,
): Promise<string> {
  const workingDraft = await readRequiredArtifact(
    runPath,
    record.artifacts.draft,
    "draft",
    MAX_RESUME_DRAFT_BYTES,
  );
  const firstCheckpoint = record.artifacts.drafts?.[0];
  if (firstCheckpoint === undefined) {
    throw new PaperbotError(
      `agent run is missing its first draft checkpoint: ${runPath}`,
      ExitCode.io,
    );
  }
  const initialDraft = await readArtifact(
    artifactPath(runPath, firstCheckpoint),
    "draft checkpoint",
    MAX_RESUME_DRAFT_BYTES,
  );
  if (sha256(workingDraft) !== sha256(initialDraft)) {
    return workingDraft;
  }
  const current = record.workflow.current_draft ?? firstCheckpoint;
  return readArtifact(
    artifactPath(runPath, current),
    "current draft checkpoint",
    MAX_RESUME_DRAFT_BYTES,
  );
}

export function assertResumableRecord(
  record: AgentRunRecord,
  runPath: string,
): void {
  if (
    record.state !== "awaiting_author" &&
    record.state !== "authoring" &&
    record.state !== "failed"
  ) {
    throw new PaperbotError(
      `agent run is not waiting for author answers: ${runPath}`,
      ExitCode.usage,
    );
  }
  if (
    record.workflow.pending_question_ids.length === 0 ||
    record.workflow.author_phase !== "reviewing"
  ) {
    throw new PaperbotError(
      `agent run is not waiting for author answers: ${runPath}`,
      ExitCode.usage,
    );
  }
}

export function requiredSessionRecord(
  record: AgentRunRecord,
  role: AgentSessionRole,
  runPath: string,
): AgentSessionRecord {
  const session = record.sessions[role];
  if (
    session === undefined ||
    typeof session.session_id !== "string" ||
    session.session_id.length === 0 ||
    typeof session.artifact !== "string" ||
    session.artifact.length === 0 ||
    typeof session.artifact_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(session.artifact_sha256) ||
    !isNonNegativeInteger(session.turn_count)
  ) {
    throw new PaperbotError(
      `agent run is missing its ${role} session: ${runPath}`,
      ExitCode.io,
    );
  }
  return session;
}

export function assertRestoredSourceMatchesRunRecord(
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

function isRunRecord(value: unknown): value is AgentRunRecord {
  return (
    isRecord(value) &&
    value.schema_version === "2" &&
    typeof value.state === "string" &&
    isRecord(value.input) &&
    isRecord(value.agent) &&
    isRecord(value.artifacts) &&
    isRecord(value.sessions) &&
    isOptionalSessionRecord(value.sessions.evidence, "evidence") &&
    isOptionalSessionRecord(value.sessions.author, "author") &&
    isRecord(value.workflow) &&
    (value.workflow.author_phase === "drafting" ||
      value.workflow.author_phase === "reviewing") &&
    isNonNegativeInteger(value.workflow.question_rounds) &&
    value.workflow.question_rounds <= MAX_AUTHOR_QUESTION_ROUNDS &&
    isNonNegativeInteger(value.workflow.draft_revision) &&
    isNonNegativeInteger(value.workflow.repair_attempts) &&
    Array.isArray(value.workflow.pending_question_ids) &&
    value.workflow.pending_question_ids.every(
      (item) => typeof item === "string",
    )
  );
}

function isOptionalSessionRecord(
  value: unknown,
  role: AgentSessionRole,
): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      typeof value.session_id === "string" &&
      value.session_id.length > 0 &&
      typeof value.artifact === "string" &&
      value.artifact.startsWith(`sessions/${role}/`) &&
      value.artifact.endsWith(".jsonl") &&
      typeof value.artifact_sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(value.artifact_sha256) &&
      isNonNegativeInteger(value.turn_count))
  );
}

function invalidRunRecord(runPath: string): PaperbotError {
  return new PaperbotError(
    `agent run record is invalid or uses an unsupported schema: ${runPath}`,
    ExitCode.io,
  );
}

function invalidEvidenceAnalysis(runPath: string): PaperbotError {
  return new PaperbotError(
    `agent evidence analysis artifact is invalid: ${runPath}`,
    ExitCode.io,
  );
}

function parseQuestionLines(
  serialized: string,
  runPath: string,
): AuthorQuestion[] {
  const lines = serialized.split("\n").filter((line) => line.length > 0);
  return lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw invalidQuestions(runPath);
    }
    if (
      !isRecord(value) ||
      value.question_id !==
        `question:${(index + 1).toString().padStart(3, "0")}` ||
      typeof value.question !== "string" ||
      value.question.length === 0 ||
      typeof value.reason !== "string" ||
      value.reason.length === 0 ||
      !Array.isArray(value.evidence_ids) ||
      !value.evidence_ids.every((item) => typeof item === "string") ||
      Object.keys(value).some(
        (field) =>
          !["question_id", "question", "reason", "evidence_ids"].includes(
            field,
          ),
      )
    ) {
      throw invalidQuestions(runPath);
    }
    return {
      question_id: value.question_id,
      question: value.question,
      reason: value.reason,
      evidence_ids: value.evidence_ids,
    };
  });
}

function invalidQuestions(runPath: string): PaperbotError {
  return new PaperbotError(
    `agent questions artifact is invalid: ${runPath}`,
    ExitCode.io,
  );
}

function readRunSourceRecord(
  value: unknown,
  runPath: string,
): AgentRunSourceRecord {
  if (!isRecord(value)) {
    throw invalidSourceRecord(runPath);
  }
  if (
    (value.kind !== "github" && value.kind !== "local") ||
    typeof value.resolved_revision !== "string" ||
    !SHA_PATTERN.test(value.resolved_revision) ||
    typeof value.is_dirty !== "boolean" ||
    typeof value.retrieved_at !== "string"
  ) {
    throw invalidSourceRecord(runPath);
  }
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
    retrieved_at: readStoredTimestamp(value.retrieved_at, runPath),
  };
}

function invalidSourceRecord(runPath: string): PaperbotError {
  return new PaperbotError(
    `agent run record has invalid source metadata: ${runPath}`,
    ExitCode.io,
  );
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
    throw invalidSourceRecord(runPath);
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) {
    throw invalidSourceRecord(runPath);
  }
  return timestamp.toISOString();
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
