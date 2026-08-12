import { ExitCode, PaperbotError } from "@prodxiv/paperbot-core";
import type {
  AgentAuthor,
  AgentPaperMetadata,
  AgentPaperRequestMetadata,
  AgentPaperStatusValue,
  AgentProductStatus,
  AgentProductStatusEvidence,
} from "./types.ts";

export const MAX_AGENT_TEXT_LENGTH = 500;
export const MAX_AGENT_URL_LENGTH = 4096;
export const MAX_AGENT_EXTERNAL_SOURCES = 50;
export const MAX_AGENT_AUTHORS = 50;

export type AgentPaperStatus = AgentPaperStatusValue;

/**
 * Normalize values that become model-prompt data. URLs are deliberately
 * anonymous, query-free, and fragment-free so a signed link cannot be
 * persisted in an artifact or interpolated into a prompt.
 */
export function normalizeAnonymousHttpUrl(
  value: unknown,
  label: string,
): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw usageError(
      `${label} must not contain leading or trailing whitespace`,
    );
  }
  const text = normalizeText(value, label, MAX_AGENT_URL_LENGTH);
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw usageError(`${label} must not contain control characters`);
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw usageError(`${label} must be an absolute anonymous HTTP(S) URL`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw usageError(
      `${label} must be an absolute anonymous query-free fragment-free HTTP(S) URL`,
    );
  }
  const normalized = url.toString();
  if (normalized.length > MAX_AGENT_URL_LENGTH) {
    throw usageError(
      `${label} exceeds the ${MAX_AGENT_URL_LENGTH}-character limit`,
    );
  }
  return normalized;
}

export function normalizeExternalSources(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw usageError("external_sources must be an array of public URLs");
  }
  if (value.length > MAX_AGENT_EXTERNAL_SOURCES) {
    throw usageError(
      `external_sources must contain at most ${MAX_AGENT_EXTERNAL_SOURCES} URLs`,
    );
  }
  const sources = value.map((source, index) =>
    normalizeAnonymousHttpUrl(source, `external_sources[${index}]`),
  );
  assertUnique(sources, "external_sources");
  return sources;
}

export function normalizeModelName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._/-]{1,200}$/.test(value)) {
    throw usageError(
      "agent model must contain only provider-safe identifier characters",
    );
  }
  return value;
}

export function normalizeAgentRequestMetadata(
  value: unknown,
): AgentPaperRequestMetadata {
  if (!isRecord(value)) {
    throw usageError("agent metadata must be an object");
  }
  const title = normalizeText(
    value.title,
    "agent metadata title",
    MAX_AGENT_TEXT_LENGTH,
  );
  const productName = normalizeText(
    value.product_name,
    "agent metadata product_name",
    MAX_AGENT_TEXT_LENGTH,
  );
  const authors = normalizeRequestedAuthors(value.authors);
  if (value.status !== undefined && !isAgentPaperStatus(value.status)) {
    throw usageError("agent metadata has an unsupported product status");
  }

  const productUrl =
    value.product_url === undefined
      ? undefined
      : normalizeAnonymousHttpUrl(
          value.product_url,
          "agent metadata product_url",
        );
  const repositoryUrl =
    value.repository_url === undefined
      ? undefined
      : normalizeAnonymousHttpUrl(
          value.repository_url,
          "agent metadata repository_url",
        );
  return {
    title,
    product_name: productName,
    ...(authors === undefined ? {} : { authors }),
    ...(value.status === undefined ? {} : { status: value.status }),
    ...(productUrl === undefined ? {} : { product_url: productUrl }),
    ...(repositoryUrl === undefined ? {} : { repository_url: repositoryUrl }),
  };
}

export function normalizeAgentMetadata(value: unknown): AgentPaperMetadata {
  if (!isRecord(value)) {
    throw usageError("agent metadata must be an object");
  }
  const request = normalizeAgentRequestMetadata({
    ...value,
    authors: undefined,
    status: undefined,
  });
  if (!Array.isArray(value.authors) || value.authors.length === 0) {
    throw usageError("completed agent metadata requires at least one author");
  }
  if (value.authors.length > MAX_AGENT_AUTHORS) {
    throw usageError(
      `agent metadata authors must contain at most ${MAX_AGENT_AUTHORS} entries`,
    );
  }
  const authors = value.authors.map((author, index) =>
    normalizeAgentAuthor(author, index),
  );
  assertUnique(
    authors.map((author) => author.id ?? `${author.kind}:${author.name}`),
    "agent metadata authors",
  );
  if (!Array.isArray(value.writers) || value.writers.length !== 1) {
    throw usageError("completed agent metadata requires one Paperbot writer");
  }
  const writer = value.writers[0];
  if (
    !isRecord(writer) ||
    writer.kind !== "agent" ||
    writer.name !== "paperbot"
  ) {
    throw usageError("completed agent metadata has an invalid Paperbot writer");
  }
  const model = normalizeModelName(writer.model);
  const toolVersion = normalizeText(
    writer.tool_version,
    "completed agent metadata writer tool_version",
  );
  const generationId = normalizeText(
    writer.generation_id,
    "completed agent metadata writer generation_id",
  );
  const status = normalizeAgentProductStatus(value.status);
  return {
    title: request.title,
    product_name: request.product_name,
    authors,
    writers: [
      {
        kind: "agent",
        name: "paperbot",
        model,
        tool_version: toolVersion,
        generation_id: generationId,
      },
    ],
    status,
    ...(request.product_url === undefined
      ? {}
      : { product_url: request.product_url }),
    ...(request.repository_url === undefined
      ? {}
      : { repository_url: request.repository_url }),
  };
}

export function isAgentPaperStatus(value: unknown): value is AgentPaperStatus {
  return (
    value === "unknown" ||
    value === "concept" ||
    value === "private_beta" ||
    value === "public_beta" ||
    value === "launched" ||
    value === "discontinued"
  );
}

function normalizeRequestedAuthors(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw usageError("agent metadata authors must be a non-empty array");
  }
  if (value.length > MAX_AGENT_AUTHORS) {
    throw usageError(
      `agent metadata authors must contain at most ${MAX_AGENT_AUTHORS} names`,
    );
  }
  const authors = value.map((author, index) =>
    normalizeText(
      author,
      `agent metadata authors[${index}]`,
      MAX_AGENT_TEXT_LENGTH,
    ),
  );
  assertUnique(authors, "agent metadata authors");
  return authors;
}

function normalizeAgentAuthor(value: unknown, index: number): AgentAuthor {
  if (
    !isRecord(value) ||
    (value.kind !== "person" && value.kind !== "organization")
  ) {
    throw usageError(`agent metadata authors[${index}] is invalid`);
  }
  const name = normalizeText(
    value.name,
    `agent metadata authors[${index}].name`,
    MAX_AGENT_TEXT_LENGTH,
  );
  const id =
    value.id === undefined
      ? undefined
      : normalizeNamespacedId(value.id, `agent metadata authors[${index}].id`);
  const url =
    value.url === undefined
      ? undefined
      : normalizeAnonymousHttpUrl(
          value.url,
          `agent metadata authors[${index}].url`,
        );
  return {
    ...(id === undefined ? {} : { id }),
    kind: value.kind,
    name,
    ...(url === undefined ? {} : { url }),
  };
}

function normalizeAgentProductStatus(value: unknown): AgentProductStatus {
  if (
    !isRecord(value) ||
    !isAgentPaperStatus(value.value) ||
    (value.determination !== "declared" &&
      value.determination !== "inferred" &&
      value.determination !== "unverified") ||
    (value.confidence !== "high" &&
      value.confidence !== "medium" &&
      value.confidence !== "low")
  ) {
    throw usageError("completed agent metadata has an invalid product status");
  }
  if ((value.value === "unknown") !== (value.determination === "unverified")) {
    throw usageError(
      "unknown status and unverified determination must be used together",
    );
  }
  const observedAt =
    value.observed_at === undefined
      ? undefined
      : normalizeTimestamp(
          value.observed_at,
          "agent metadata status observed_at",
        );
  const evidence = normalizeStatusEvidence(value.evidence);
  if (
    value.determination === "inferred" &&
    (observedAt === undefined || evidence.length === 0)
  ) {
    throw usageError(
      "inferred agent status requires observed_at and release evidence",
    );
  }
  return {
    value: value.value,
    determination: value.determination,
    confidence: value.confidence,
    ...(observedAt === undefined ? {} : { observed_at: observedAt }),
    ...(evidence.length === 0 ? {} : { evidence }),
  };
}

function normalizeStatusEvidence(value: unknown): AgentProductStatusEvidence[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw usageError("agent metadata status evidence must be an array");
  }
  const evidence = value.map((item, index) => {
    if (!isRecord(item) || item.kind !== "github_release") {
      throw usageError(`agent metadata status evidence[${index}] is invalid`);
    }
    return {
      kind: "github_release" as const,
      url: normalizeAnonymousHttpUrl(
        item.url,
        `agent metadata status evidence[${index}].url`,
      ),
      tag: normalizeText(
        item.tag,
        `agent metadata status evidence[${index}].tag`,
        MAX_AGENT_TEXT_LENGTH,
      ),
    };
  });
  assertUnique(
    evidence.map((item) => item.url),
    "agent metadata status evidence URLs",
  );
  return evidence;
}

function normalizeNamespacedId(value: unknown, label: string): string {
  const id = normalizeText(value, label, MAX_AGENT_TEXT_LENGTH);
  if (!/^[a-z][a-z0-9_-]*:[^\s:][^\s]*$/.test(id)) {
    throw usageError(
      `${label} must use a namespaced value such as github:owner`,
    );
  }
  return id;
}

function normalizeTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
  ) {
    throw usageError(`${label} must use UTC RFC 3339 notation`);
  }
  const timestamp = new Date(value);
  if (
    Number.isNaN(timestamp.valueOf()) ||
    timestamp.toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    throw usageError(`${label} must be a valid timestamp`);
  }
  return timestamp.toISOString();
}

export function normalizeText(
  value: unknown,
  label: string,
  maximumLength: number = MAX_AGENT_TEXT_LENGTH,
): string {
  if (typeof value !== "string") {
    throw usageError(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw usageError(
      `${label} must contain from 1 to ${maximumLength} non-control characters`,
    );
  }
  return normalized;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw usageError(`${label} must not contain duplicate values`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usageError(message: string): PaperbotError {
  return new PaperbotError(message, ExitCode.usage);
}
