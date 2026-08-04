import { ExitCode, PaperbotError } from "@prodxiv/paperbot-core";
import type {
  AskQuestionsResponse,
  AuthoringResponse,
  DraftResponse,
  EvidenceCandidate,
  EvidenceConflict,
  EvidenceKind,
  EvidenceResponse,
} from "./types.ts";

const EVIDENCE_KINDS = new Set<EvidenceKind>([
  "repository",
  "external",
  "author",
  "inference",
]);
const CONFIDENCES = new Set(["high", "medium", "low"]);
const MAX_EVIDENCE_ITEMS = 64;
const MAX_EVIDENCE_EXCERPT_CHARACTERS = 2_000;
const MAX_CONTRADICTIONS = 16;
const MAX_UNKNOWN_ITEMS = 24;
const MAX_QUESTIONS_PER_ROUND = 5;
const MAX_RESPONSE_TEXT_CHARACTERS = 2_000;
const MAX_DRAFT_CHARACTERS = 256 * 1024;

export function parseEvidenceResponse(value: string): EvidenceResponse {
  const object = parseJsonObject(value, "evidence");
  assertOnlyFields(
    object,
    ["evidence", "contradictions", "unknowns", "questions"],
    "evidence",
  );
  if (!Array.isArray(object.evidence)) {
    invalidResponse("evidence.evidence must be an array");
  }
  if (object.evidence.length > MAX_EVIDENCE_ITEMS) {
    invalidResponse(
      `evidence.evidence must contain at most ${MAX_EVIDENCE_ITEMS} items`,
    );
  }
  if (!Array.isArray(object.contradictions)) {
    invalidResponse("evidence.contradictions must be an array");
  }
  if (object.contradictions.length > MAX_CONTRADICTIONS) {
    invalidResponse(
      `evidence.contradictions must contain at most ${MAX_CONTRADICTIONS} items`,
    );
  }
  return {
    evidence: object.evidence.map((item, index) =>
      evidenceCandidate(item, `evidence.evidence[${index}]`),
    ),
    contradictions: object.contradictions.map((item, index) =>
      evidenceConflict(item, index),
    ),
    unknowns: boundedStringArray(
      object.unknowns,
      "evidence.unknowns",
      MAX_UNKNOWN_ITEMS,
    ),
    questions: boundedStringArray(
      object.questions,
      "evidence.questions",
      MAX_UNKNOWN_ITEMS,
    ),
  };
}

export function parseAuthoringResponse(value: string): AuthoringResponse {
  const object = parseJsonObject(value, "authoring");
  const action = requiredString(object.action, "authoring.action");
  if (action === "ask_questions") {
    return parseAskQuestionsResponse(object);
  }
  if (action === "submit_draft") {
    return parseDraftObject(object);
  }
  invalidResponse(`authoring.action is not recognized: ${action}`);
}

export function parseDraftResponse(value: string): DraftResponse {
  const response = parseAuthoringResponse(value);
  if (response.action !== "submit_draft") {
    invalidResponse("authoring response must submit a draft in this phase");
  }
  return response;
}

export function validateEvidenceCandidateSourceIds(
  evidence: EvidenceCandidate[],
  allowedSourceIds: ReadonlySet<string>,
): EvidenceCandidate[] {
  for (const item of evidence) {
    if (item.evidence_kind === "external") {
      invalidResponse(
        "external URLs are reference-only until Paperbot snapshots their contents",
      );
    }
    if (item.evidence_kind === "author") {
      invalidResponse(
        "the evidence session cannot create author evidence before answers are supplied",
      );
    }
    if (!allowedSourceIds.has(item.source_id)) {
      invalidResponse(`evidence source_id is not available: ${item.source_id}`);
    }
    if (!isRepositorySourceId(item.source_id)) {
      invalidResponse(
        `${item.evidence_kind} evidence must use a repository source_id: ${item.source_id}`,
      );
    }
  }
  return evidence;
}

export function validateConflictSourceIds(
  conflicts: EvidenceConflict[],
  allowedSourceIds: ReadonlySet<string>,
): EvidenceConflict[] {
  for (const conflict of conflicts) {
    const invalidSourceId = conflict.source_ids.find(
      (sourceId) => !allowedSourceIds.has(sourceId),
    );
    if (invalidSourceId !== undefined) {
      invalidResponse(
        `contradiction source_id is not available: ${invalidSourceId}`,
      );
    }
  }
  return conflicts;
}

export function validateAuthoringEvidenceIds(
  response: AuthoringResponse,
  allowedEvidenceIds: ReadonlySet<string>,
): AuthoringResponse {
  const evidenceIds =
    response.action === "submit_draft"
      ? response.evidence_ids
      : response.questions.flatMap((question) => question.evidence_ids);
  const invalidEvidenceId = evidenceIds.find(
    (evidenceId) => !allowedEvidenceIds.has(evidenceId),
  );
  if (invalidEvidenceId !== undefined) {
    invalidResponse(`evidence_id is not available: ${invalidEvidenceId}`);
  }
  return response;
}

function parseAskQuestionsResponse(
  object: Record<string, unknown>,
): AskQuestionsResponse {
  assertOnlyFields(object, ["action", "questions"], "authoring");
  if (!Array.isArray(object.questions)) {
    invalidResponse("authoring.questions must be an array");
  }
  if (
    object.questions.length === 0 ||
    object.questions.length > MAX_QUESTIONS_PER_ROUND
  ) {
    invalidResponse(
      `authoring.questions must contain one to ${MAX_QUESTIONS_PER_ROUND} questions`,
    );
  }
  return {
    action: "ask_questions",
    questions: object.questions.map((value, index) => {
      const path = `authoring.questions[${index}]`;
      if (!isRecord(value)) {
        invalidResponse(`${path} must be an object`);
      }
      assertOnlyFields(value, ["question", "reason", "evidence_ids"], path);
      return {
        question: boundedString(
          value.question,
          `${path}.question`,
          MAX_RESPONSE_TEXT_CHARACTERS,
        ),
        reason: boundedString(
          value.reason,
          `${path}.reason`,
          MAX_RESPONSE_TEXT_CHARACTERS,
        ),
        evidence_ids: boundedStringArray(
          value.evidence_ids,
          `${path}.evidence_ids`,
          MAX_EVIDENCE_ITEMS,
          100,
        ),
      };
    }),
  };
}

function parseDraftObject(object: Record<string, unknown>): DraftResponse {
  assertOnlyFields(
    object,
    [
      "action",
      "summary",
      "topics",
      "markdown",
      "evidence_ids",
      "unresolved_questions",
    ],
    "authoring",
  );
  const markdown = requiredString(object.markdown, "authoring.markdown");
  if (markdown.length > MAX_DRAFT_CHARACTERS) {
    invalidResponse(
      `authoring.markdown must contain at most ${MAX_DRAFT_CHARACTERS} characters`,
    );
  }
  if (markdown.trimStart().startsWith("---")) {
    invalidResponse("authoring.markdown must not contain YAML front matter");
  }
  return {
    action: "submit_draft",
    summary: boundedString(
      object.summary,
      "authoring.summary",
      MAX_RESPONSE_TEXT_CHARACTERS,
    ),
    topics: boundedStringArray(object.topics, "authoring.topics", 5, 100),
    markdown,
    evidence_ids: boundedStringArray(
      object.evidence_ids,
      "authoring.evidence_ids",
      MAX_EVIDENCE_ITEMS,
      100,
    ),
    unresolved_questions: boundedStringArray(
      object.unresolved_questions,
      "authoring.unresolved_questions",
      MAX_UNKNOWN_ITEMS,
      MAX_RESPONSE_TEXT_CHARACTERS,
    ),
  };
}

function evidenceCandidate(value: unknown, path: string): EvidenceCandidate {
  if (!isRecord(value)) {
    invalidResponse(`${path} must be an object`);
  }
  assertOnlyFields(
    value,
    ["claim", "evidence_kind", "source_id", "excerpt", "confidence", "note"],
    path,
  );
  const evidenceKind = requiredString(
    value.evidence_kind,
    `${path}.evidence_kind`,
  );
  if (!EVIDENCE_KINDS.has(evidenceKind as EvidenceKind)) {
    invalidResponse(`${path}.evidence_kind is not recognized`);
  }
  const confidence = requiredString(value.confidence, `${path}.confidence`);
  if (!CONFIDENCES.has(confidence)) {
    invalidResponse(`${path}.confidence is not recognized`);
  }
  const excerpt = requiredString(value.excerpt, `${path}.excerpt`);
  if (excerpt.length > MAX_EVIDENCE_EXCERPT_CHARACTERS) {
    invalidResponse(
      `${path}.excerpt must contain at most ${MAX_EVIDENCE_EXCERPT_CHARACTERS} characters`,
    );
  }
  const note = optionalString(
    value.note,
    `${path}.note`,
    MAX_RESPONSE_TEXT_CHARACTERS,
  );
  return {
    claim: boundedString(
      value.claim,
      `${path}.claim`,
      MAX_RESPONSE_TEXT_CHARACTERS,
    ),
    evidence_kind: evidenceKind as EvidenceKind,
    source_id: boundedString(value.source_id, `${path}.source_id`, 500),
    excerpt,
    confidence: confidence as EvidenceCandidate["confidence"],
    ...(note === undefined ? {} : { note }),
  };
}

function evidenceConflict(value: unknown, index: number): EvidenceConflict {
  const path = `evidence.contradictions[${index}]`;
  if (!isRecord(value)) {
    invalidResponse(`${path} must be an object`);
  }
  assertOnlyFields(value, ["description", "source_ids"], path);
  return {
    description: boundedString(
      value.description,
      `${path}.description`,
      MAX_RESPONSE_TEXT_CHARACTERS,
    ),
    source_ids: boundedStringArray(
      value.source_ids,
      `${path}.source_ids`,
      MAX_EVIDENCE_ITEMS,
      500,
    ),
  };
}

function isRepositorySourceId(sourceId: string): boolean {
  return sourceId.startsWith("repository:");
}

function parseJsonObject(
  value: string,
  artifact: string,
): Record<string, unknown> {
  const fenced = value.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  const serialized = (fenced?.[1] ?? value).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    invalidResponse(`${artifact} response is not valid JSON`);
  }
  if (!isRecord(parsed)) {
    invalidResponse(`${artifact} response must be a JSON object`);
  }
  return parsed;
}

function boundedStringArray(
  value: unknown,
  path: string,
  maximumItems: number,
  maximumCharacters = MAX_RESPONSE_TEXT_CHARACTERS,
): string[] {
  const values = uniqueStringArray(value, path);
  if (values.length > maximumItems) {
    invalidResponse(`${path} must contain at most ${maximumItems} items`);
  }
  const oversizedIndex = values.findIndex(
    (item) => item.length > maximumCharacters,
  );
  if (oversizedIndex !== -1) {
    invalidResponse(
      `${path}[${oversizedIndex}] must contain at most ${maximumCharacters} characters`,
    );
  }
  return values;
}

function uniqueStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    invalidResponse(`${path} must be an array`);
  }
  const values = value.map((item, index) =>
    requiredString(item, `${path}[${index}]`),
  );
  if (new Set(values).size !== values.length) {
    invalidResponse(`${path} must not contain duplicates`);
  }
  return values;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidResponse(`${path} must be a non-empty string`);
  }
  return value;
}

function boundedString(
  value: unknown,
  path: string,
  maximumCharacters: number,
): string {
  const result = requiredString(value, path);
  if (result.length > maximumCharacters) {
    invalidResponse(
      `${path} must contain at most ${maximumCharacters} characters`,
    );
  }
  return result;
}

function optionalString(
  value: unknown,
  path: string,
  maximumCharacters: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return boundedString(value, path, maximumCharacters);
}

function assertOnlyFields(
  value: Record<string, unknown>,
  allowedFields: string[],
  path: string,
): void {
  const allowed = new Set(allowedFields);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown !== undefined) {
    invalidResponse(`${path} contains an unknown field: ${unknown}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(message: string): never {
  throw new PaperbotError(
    `agent returned an invalid response: ${message}`,
    ExitCode.validation,
  );
}
