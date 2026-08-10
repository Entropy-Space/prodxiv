import { ExitCode, PaperbotError } from "@prodxiv/paperbot-core";
import { sha256 } from "./artifacts.ts";
import type {
  AgentSource,
  EvidenceCandidate,
  EvidenceCandidateLocator,
  EvidenceItem,
  EvidenceStatus,
} from "./types.ts";

const MAX_EVIDENCE_EXCERPT_CHARACTERS = 2_000;

export interface AuthorEvidenceSource {
  source_id: string;
  path: string;
  content: string;
}

export function buildValidatedEvidence(
  candidates: EvidenceCandidate[],
  source: AgentSource,
): EvidenceItem[] {
  if (candidates.length === 0) {
    invalidEvidence("at least one repository evidence item is required");
  }
  const sourceFiles = availableEvidenceSources(source);
  const seen = new Set<string>();
  return candidates.map((candidate, index) => {
    const sourceFile = sourceFiles.get(candidate.source_id);
    if (sourceFile === undefined) {
      invalidEvidence(`source_id is not available: ${candidate.source_id}`);
    }
    if (
      candidate.evidence_kind !== sourceFile.evidence_kind &&
      candidate.evidence_kind !== "inference"
    ) {
      invalidEvidence(
        `evidence_kind does not match its source: ${candidate.source_id}`,
      );
    }
    const duplicateKey = [
      candidate.source_id,
      candidate.claim,
      candidate.locator.line_start,
      candidate.locator.line_end,
    ].join("\u0000");
    if (seen.has(duplicateKey)) {
      invalidEvidence(`duplicate evidence item at index ${index}`);
    }
    seen.add(duplicateKey);
    const excerpt = extractSourceSpan(
      sourceFile.content,
      candidate.locator,
      sourceFile.path,
    );
    const { locator: selectedLocator, ...candidateFields } = candidate;
    return {
      evidence_id: formatEvidenceId(index + 1),
      ...candidateFields,
      excerpt,
      excerpt_sha256: sha256(excerpt),
      locator: { path: sourceFile.path, ...selectedLocator },
      status:
        candidate.evidence_kind === "repository" ||
        candidate.evidence_kind === "external"
          ? "source_verified"
          : "qualified_inference",
    };
  });
}

export function appendAuthorEvidence(
  evidence: EvidenceItem[],
  source: AuthorEvidenceSource,
  round: number,
): EvidenceItem[] {
  const excerpt = source.content.trim();
  if (excerpt.length === 0) {
    invalidEvidence("author answers must not be empty");
  }
  return [
    ...evidence,
    {
      evidence_id: formatEvidenceId(evidence.length + 1),
      claim: `The author supplied contextual answers for question round ${round}.`,
      evidence_kind: "author",
      source_id: source.source_id,
      excerpt,
      excerpt_sha256: sha256(excerpt),
      locator: locateExcerpt(source.content, excerpt, source.path),
      confidence: "high",
      status: "author_supplied",
    },
  ];
}

export function formatEvidenceJsonLines(evidence: EvidenceItem[]): string {
  return (
    evidence.map((item) => JSON.stringify(item)).join("\n") +
    (evidence.length === 0 ? "" : "\n")
  );
}

export function parseStoredEvidence(
  serialized: string,
  source: AgentSource,
  authorSources: ReadonlyMap<string, AuthorEvidenceSource> = new Map(),
): EvidenceItem[] {
  const lines = serialized.split("\n").filter((line) => line.length > 0);
  let parsed: unknown[];
  try {
    parsed = lines.map((line) => JSON.parse(line) as unknown);
  } catch {
    invalidStoredEvidence("evidence.jsonl is not valid JSON Lines");
  }
  const sourceFiles = availableEvidenceSources(source);
  return parsed.map((value, index) => {
    const item = parseStoredEvidenceItem(value, index);
    if (item.evidence_id !== formatEvidenceId(index + 1)) {
      invalidStoredEvidence("evidence IDs are not in canonical order");
    }
    const expectedStatus = expectedEvidenceStatus(item.evidence_kind);
    if (item.status !== expectedStatus) {
      invalidStoredEvidence(
        `evidence status does not match evidence_kind: ${item.evidence_id}`,
      );
    }
    const content =
      item.evidence_kind === "author"
        ? authorSources.get(item.source_id)?.content
        : sourceFiles.get(item.source_id)?.content;
    const path =
      item.evidence_kind === "author"
        ? authorSources.get(item.source_id)?.path
        : sourceFiles.get(item.source_id)?.path;
    if (content === undefined || path === undefined) {
      invalidStoredEvidence(
        `evidence source is not available: ${item.source_id}`,
      );
    }
    if (sha256(item.excerpt) !== item.excerpt_sha256) {
      invalidStoredEvidence(
        `evidence excerpt digest does not match: ${item.evidence_id}`,
      );
    }
    if (item.locator.path !== path) {
      invalidStoredEvidence(
        `evidence path does not match: ${item.evidence_id}`,
      );
    }
    if (item.evidence_kind === "author") {
      const locator = locateExcerpt(
        content,
        item.excerpt,
        path,
        invalidStoredEvidence,
      );
      if (
        locator.line_start !== item.locator.line_start ||
        locator.line_end !== item.locator.line_end
      ) {
        invalidStoredEvidence(
          `evidence locator does not match its source: ${item.evidence_id}`,
        );
      }
    } else if (
      extractSourceSpan(content, item.locator, path, invalidStoredEvidence) !==
      item.excerpt
    ) {
      invalidStoredEvidence(
        `evidence excerpt does not match its selected lines: ${item.evidence_id}`,
      );
    }
    return item;
  });
}

export function evidenceIds(evidence: EvidenceItem[]): Set<string> {
  return new Set(evidence.map((item) => item.evidence_id));
}

function parseStoredEvidenceItem(value: unknown, index: number): EvidenceItem {
  if (!isRecord(value)) {
    invalidStoredEvidence(`evidence item ${index + 1} must be an object`);
  }
  const allowedFields = new Set([
    "evidence_id",
    "claim",
    "evidence_kind",
    "source_id",
    "excerpt",
    "excerpt_sha256",
    "locator",
    "confidence",
    "status",
    "note",
  ]);
  const unknownField = Object.keys(value).find(
    (field) => !allowedFields.has(field),
  );
  if (unknownField !== undefined) {
    invalidStoredEvidence(
      `evidence item contains unknown field: ${unknownField}`,
    );
  }
  if (!isRecord(value.locator)) {
    invalidStoredEvidence(`evidence item ${index + 1} has an invalid locator`);
  }
  const locatorFields = Object.keys(value.locator);
  if (
    locatorFields.some(
      (field) => !["path", "line_start", "line_end"].includes(field),
    )
  ) {
    invalidStoredEvidence(
      `evidence item ${index + 1} has an invalid locator field`,
    );
  }
  const evidenceKind = requiredString(value.evidence_kind, "evidence_kind");
  if (
    evidenceKind !== "repository" &&
    evidenceKind !== "external" &&
    evidenceKind !== "inference" &&
    evidenceKind !== "author"
  ) {
    invalidStoredEvidence(`evidence_kind is not supported: ${evidenceKind}`);
  }
  const confidence = requiredString(value.confidence, "confidence");
  if (
    confidence !== "high" &&
    confidence !== "medium" &&
    confidence !== "low"
  ) {
    invalidStoredEvidence(
      `evidence confidence is not supported: ${confidence}`,
    );
  }
  const status = requiredString(value.status, "status");
  if (
    status !== "source_verified" &&
    status !== "qualified_inference" &&
    status !== "author_supplied"
  ) {
    invalidStoredEvidence(`evidence status is not supported: ${status}`);
  }
  const note = value.note;
  if (note !== undefined && (typeof note !== "string" || note.length === 0)) {
    invalidStoredEvidence("evidence note must be a non-empty string");
  }
  return {
    evidence_id: requiredString(value.evidence_id, "evidence_id"),
    claim: requiredString(value.claim, "claim"),
    evidence_kind: evidenceKind,
    source_id: requiredString(value.source_id, "source_id"),
    excerpt: requiredString(value.excerpt, "excerpt"),
    excerpt_sha256: requiredDigest(value.excerpt_sha256),
    locator: {
      path: requiredString(value.locator.path, "locator.path"),
      line_start: requiredPositiveInteger(
        value.locator.line_start,
        "locator.line_start",
      ),
      line_end: requiredPositiveInteger(
        value.locator.line_end,
        "locator.line_end",
      ),
    },
    confidence,
    status,
    ...(note === undefined ? {} : { note }),
  };
}

function expectedEvidenceStatus(
  evidenceKind: EvidenceItem["evidence_kind"],
): EvidenceStatus {
  if (evidenceKind === "repository") {
    return "source_verified";
  }
  if (evidenceKind === "external") {
    return "source_verified";
  }
  if (evidenceKind === "inference") {
    return "qualified_inference";
  }
  if (evidenceKind === "author") {
    return "author_supplied";
  }
  invalidStoredEvidence("external evidence is not supported");
}

function availableEvidenceSources(source: AgentSource): Map<
  string,
  {
    path: string;
    content: string;
    evidence_kind: "repository" | "external";
  }
> {
  const sources = new Map<
    string,
    {
      path: string;
      content: string;
      evidence_kind: "repository" | "external";
    }
  >();
  for (const file of source.files) {
    sources.set(file.source_id, {
      path: file.path,
      content: file.content,
      evidence_kind: "repository",
    });
  }
  for (const release of source.github_releases?.releases ?? []) {
    if (release.notes !== undefined) {
      sources.set(release.source_id, {
        path: release.source_path,
        content: release.notes,
        evidence_kind: "external",
      });
    }
  }
  return sources;
}

function locateExcerpt(
  content: string,
  excerpt: string,
  path: string,
  reject: (message: string) => never = invalidEvidence,
) {
  const offset = content.indexOf(excerpt);
  if (offset === -1) {
    reject(`excerpt is not an exact substring of source: ${path}`);
  }
  const lineStart = countLines(content.slice(0, offset));
  return {
    path,
    line_start: lineStart,
    line_end: lineStart + countNewlines(excerpt),
  };
}

function extractSourceSpan(
  content: string,
  locator: EvidenceCandidateLocator,
  path: string,
  reject: (message: string) => never = invalidEvidence,
): string {
  const lineStarts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n" && index + 1 < content.length) {
      lineStarts.push(index + 1);
    }
  }
  if (
    locator.line_start > lineStarts.length ||
    locator.line_end > lineStarts.length
  ) {
    reject(
      `selected lines ${locator.line_start}-${locator.line_end} exceed ${path}'s ${lineStarts.length} lines`,
    );
  }
  const startOffset = lineStarts[locator.line_start - 1];
  const finalLineStart = lineStarts[locator.line_end - 1];
  if (startOffset === undefined || finalLineStart === undefined) {
    reject(`selected lines are not available in source: ${path}`);
  }
  const newlineOffset = content.indexOf("\n", finalLineStart);
  let endOffset = newlineOffset === -1 ? content.length : newlineOffset;
  if (endOffset > finalLineStart && content[endOffset - 1] === "\r") {
    endOffset -= 1;
  }
  const excerpt = content.slice(startOffset, endOffset);
  if (excerpt.trim().length === 0) {
    reject(`selected lines contain no evidence text: ${path}`);
  }
  if (excerpt.length > MAX_EVIDENCE_EXCERPT_CHARACTERS) {
    reject(
      `selected lines exceed ${MAX_EVIDENCE_EXCERPT_CHARACTERS} characters: ${path}`,
    );
  }
  return excerpt;
}

function countLines(value: string): number {
  return countNewlines(value) + 1;
}

function countNewlines(value: string): number {
  let count = 0;
  for (const character of value) {
    if (character === "\n") {
      count += 1;
    }
  }
  return count;
}

function formatEvidenceId(index: number): string {
  return `evidence:${index.toString().padStart(3, "0")}`;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalidStoredEvidence(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredDigest(value: unknown): string {
  const digest = requiredString(value, "excerpt_sha256");
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    invalidStoredEvidence("excerpt_sha256 must be a lowercase SHA-256 digest");
  }
  return digest;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    invalidStoredEvidence(`${field} must be a positive integer`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidEvidence(message: string): never {
  throw new PaperbotError(
    `agent evidence failed integrity validation: ${message}`,
    ExitCode.validation,
  );
}

function invalidStoredEvidence(message: string): never {
  throw new PaperbotError(
    `stored agent evidence is invalid: ${message}`,
    ExitCode.io,
  );
}
