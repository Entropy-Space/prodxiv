import { ExitCode, PaperbotError } from "../errors.ts";
import type {
  DraftResponse,
  EvidenceItem,
  EvidenceKind,
  ReviewIssue,
  ReviewResponse,
  ReviewSeverity,
} from "./types.ts";

const EVIDENCE_KINDS = new Set<EvidenceKind>([
  "repository",
  "external",
  "author",
  "inference",
]);
const REVIEW_SEVERITIES = new Set<ReviewSeverity>([
  "error",
  "warning",
  "question",
]);
const CONFIDENCES = new Set(["high", "medium", "low"]);

export function parseDraftResponse(value: string): DraftResponse {
  const object = parseJsonObject(value, "draft");
  const summary = requiredString(object.summary, "draft.summary");
  const markdown = requiredString(object.markdown, "draft.markdown");
  if (markdown.trimStart().startsWith("---")) {
    invalidResponse("draft.markdown must not contain YAML front matter");
  }
  return {
    summary,
    topics: stringArray(object.topics, "draft.topics"),
    markdown,
    evidence: evidenceArray(object.evidence),
    questions: stringArray(object.questions, "draft.questions"),
  };
}

export function parseReviewResponse(value: string): ReviewResponse {
  const object = parseJsonObject(value, "review");
  if (!Array.isArray(object.issues)) {
    invalidResponse("review.issues must be an array");
  }
  return {
    issues: object.issues.map((item, index) => reviewIssue(item, index)),
    questions: stringArray(object.questions, "review.questions"),
  };
}

export function validateEvidenceSourceIds(
  evidence: EvidenceItem[],
  allowedSourceIds: ReadonlySet<string>,
): EvidenceItem[] {
  for (const item of evidence) {
    if (item.evidence_kind === "external") {
      invalidResponse(
        "external URLs are reference-only until Paperbot snapshots their contents",
      );
    }
    if (!allowedSourceIds.has(item.source_id)) {
      invalidResponse(`evidence source_id is not available: ${item.source_id}`);
    }
    if (
      item.evidence_kind === "repository" &&
      !isRepositorySourceId(item.source_id)
    ) {
      invalidResponse(
        `repository evidence must use a repository source_id: ${item.source_id}`,
      );
    }
    if (item.evidence_kind === "author" && !isAuthorSourceId(item.source_id)) {
      invalidResponse(
        `author evidence must use an author source_id: ${item.source_id}`,
      );
    }
    if (
      item.evidence_kind === "inference" &&
      !isRepositorySourceId(item.source_id) &&
      !isAuthorSourceId(item.source_id)
    ) {
      invalidResponse(
        `inference must identify a repository or author source_id: ${item.source_id}`,
      );
    }
  }
  return evidence;
}

export function validateReviewSourceIds(
  review: ReviewResponse,
  allowedSourceIds: ReadonlySet<string>,
): ReviewResponse {
  for (const issue of review.issues) {
    const invalidSourceId = issue.source_ids.find(
      (sourceId) =>
        !allowedSourceIds.has(sourceId) ||
        (!isRepositorySourceId(sourceId) && !isAuthorSourceId(sourceId)),
    );
    if (invalidSourceId !== undefined) {
      invalidResponse(`review source_id is not available: ${invalidSourceId}`);
    }
  }
  return review;
}

function isRepositorySourceId(sourceId: string): boolean {
  return sourceId.startsWith("repository:");
}

function isAuthorSourceId(sourceId: string): boolean {
  return sourceId.startsWith("author:");
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

function evidenceArray(value: unknown): EvidenceItem[] {
  if (!Array.isArray(value)) {
    invalidResponse("draft.evidence must be an array");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      invalidResponse(`draft.evidence[${index}] must be an object`);
    }
    const evidenceKind = requiredString(
      item.evidence_kind,
      `draft.evidence[${index}].evidence_kind`,
    );
    if (!EVIDENCE_KINDS.has(evidenceKind as EvidenceKind)) {
      invalidResponse(
        `draft.evidence[${index}].evidence_kind is not recognized`,
      );
    }
    const confidence = requiredString(
      item.confidence,
      `draft.evidence[${index}].confidence`,
    );
    if (!CONFIDENCES.has(confidence)) {
      invalidResponse(`draft.evidence[${index}].confidence is not recognized`);
    }
    const note = item.note;
    if (note !== undefined && typeof note !== "string") {
      invalidResponse(`draft.evidence[${index}].note must be a string`);
    }
    return {
      claim: requiredString(item.claim, `draft.evidence[${index}].claim`),
      evidence_kind: evidenceKind as EvidenceKind,
      source_id: requiredString(
        item.source_id,
        `draft.evidence[${index}].source_id`,
      ),
      confidence: confidence as EvidenceItem["confidence"],
      ...(note === undefined ? {} : { note }),
    };
  });
}

function reviewIssue(value: unknown, index: number): ReviewIssue {
  if (!isRecord(value)) {
    invalidResponse(`review.issues[${index}] must be an object`);
  }
  const severity = requiredString(
    value.severity,
    `review.issues[${index}].severity`,
  );
  if (!REVIEW_SEVERITIES.has(severity as ReviewSeverity)) {
    invalidResponse(`review.issues[${index}].severity is not recognized`);
  }
  return {
    severity: severity as ReviewSeverity,
    section: requiredString(value.section, `review.issues[${index}].section`),
    message: requiredString(value.message, `review.issues[${index}].message`),
    source_ids: stringArray(
      value.source_ids,
      `review.issues[${index}].source_ids`,
    ),
  };
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    invalidResponse(`${path} must be an array`);
  }
  return value.map((item, index) => requiredString(item, `${path}[${index}]`));
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidResponse(`${path} must be a non-empty string`);
  }
  return value;
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
