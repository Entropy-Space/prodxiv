import { ExitCode, PaperbotError } from "../errors.ts";
import type { AgentPaperMetadata } from "./types.ts";

export const MAX_AGENT_TEXT_LENGTH = 500;
export const MAX_AGENT_URL_LENGTH = 4096;
export const MAX_AGENT_EXTERNAL_SOURCES = 50;
export const MAX_AGENT_AUTHORS = 50;

export type AgentPaperStatus = AgentPaperMetadata["status"];

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

export function normalizeAgentMetadata(value: unknown): AgentPaperMetadata {
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
  if (!Array.isArray(value.authors) || value.authors.length === 0) {
    throw usageError("agent metadata requires at least one author");
  }
  if (value.authors.length > MAX_AGENT_AUTHORS) {
    throw usageError(
      `agent metadata authors must contain at most ${MAX_AGENT_AUTHORS} names`,
    );
  }
  const authors = value.authors.map((author, index) =>
    normalizeText(
      author,
      `agent metadata authors[${index}]`,
      MAX_AGENT_TEXT_LENGTH,
    ),
  );
  assertUnique(authors, "agent metadata authors");
  if (!isAgentPaperStatus(value.status)) {
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
    authors,
    status: value.status,
    ...(productUrl === undefined ? {} : { product_url: productUrl }),
    ...(repositoryUrl === undefined ? {} : { repository_url: repositoryUrl }),
  };
}

export function isAgentPaperStatus(value: unknown): value is AgentPaperStatus {
  return (
    value === "concept" ||
    value === "private_beta" ||
    value === "public_beta" ||
    value === "launched" ||
    value === "discontinued"
  );
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
