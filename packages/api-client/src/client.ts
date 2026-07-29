import type { components } from "./generated/api.ts";

export type PublishedPaper = components["schemas"]["PublishedPaper"];
export type PublishedPaperSummary =
  components["schemas"]["PublishedPaperSummary"];
type ErrorResponse = components["schemas"]["ErrorResponse"];
type ErrorDiagnostics = NonNullable<ErrorResponse["error"]["diagnostics"]>;

export interface PublishPaperInput {
  source_markdown: string;
  idempotency_key: string;
  product_id?: string;
}

export interface PublishPaperResult {
  paper: PublishedPaper;
  location: string;
  replayed: boolean;
}

export interface ListPapersInput {
  limit?: number;
  cursor?: string;
}

export interface PaperList {
  papers: PublishedPaperSummary[];
  next_cursor?: string;
}

export type ApiFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ProdxivApiClientOptions {
  api_url: string;
  token?: string;
  fetch?: ApiFetch;
}

export class ProdxivApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly diagnostics: ErrorDiagnostics;

  constructor(
    status: number,
    code: string,
    message: string,
    diagnostics: ErrorDiagnostics = [],
  ) {
    super(message);
    this.name = "ProdxivApiError";
    this.status = status;
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export class ProdxivApiClient {
  readonly #apiUrl: string;
  readonly #token: string | undefined;
  readonly #fetch: ApiFetch;

  constructor(options: ProdxivApiClientOptions) {
    this.#apiUrl = options.api_url.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async publishPaper(input: PublishPaperInput): Promise<PublishPaperResult> {
    if (this.#token === undefined || this.#token.length === 0) {
      throw new ProdxivApiError(
        0,
        "auth.token_missing",
        "publishing requires a bearer token",
      );
    }
    const { response, body } = await this.#request("/v1/papers", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
        "idempotency-key": input.idempotency_key,
      },
      body: JSON.stringify({
        source_markdown: input.source_markdown,
        ...(input.product_id === undefined
          ? {}
          : { product_id: input.product_id }),
      }),
    });

    const paper = publishedPaper(response, body);

    return {
      paper,
      location:
        response.headers.get("location") ??
        `/v1/papers/${paper.paper_id}/revisions/${paper.version}`,
      replayed: response.status === 200,
    };
  }

  async getPaperRevision(
    paperId: string,
    revision: number,
  ): Promise<PublishedPaper> {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new ProdxivApiError(
        0,
        "request.invalid_revision",
        "paper revision must be a positive safe integer",
      );
    }
    const path = `/v1/papers/${encodeURIComponent(paperId)}/revisions/${revision}`;
    const { response, body } = await this.#request(path);
    return publishedPaper(response, body);
  }

  /** @deprecated Use getPaperRevision. */
  async getPaperVersion(
    paperId: string,
    version: number,
  ): Promise<PublishedPaper> {
    return this.getPaperRevision(paperId, version);
  }

  async listPapers(input: ListPapersInput = {}): Promise<PaperList> {
    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    ) {
      throw new ProdxivApiError(
        0,
        "request.invalid_limit",
        "paper list limit must be an integer between 1 and 100",
      );
    }
    if (input.cursor !== undefined && input.cursor.length === 0) {
      throw new ProdxivApiError(
        0,
        "request.invalid_cursor",
        "paper list cursor must not be empty",
      );
    }
    const query = new URLSearchParams();
    if (input.limit !== undefined) {
      query.set("limit", String(input.limit));
    }
    if (input.cursor !== undefined) {
      query.set("cursor", input.cursor);
    }
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const { response, body } = await this.#request(`/v1/papers${suffix}`);
    return paperList(response, body);
  }

  async #request(
    path: string,
    init?: RequestInit,
  ): Promise<{ response: Response; body: unknown }> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiUrl}${path}`, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProdxivApiError(
        0,
        "network.request_failed",
        `API request failed: ${message}`,
      );
    }
    const body = (await response.json().catch(() => undefined)) as unknown;
    return { response, body };
  }
}

function publishedPaper(response: Response, body: unknown): PublishedPaper {
  if (!response.ok) {
    if (isErrorResponse(body)) {
      throw new ProdxivApiError(
        response.status,
        body.error.code,
        body.error.message,
        body.error.diagnostics ?? [],
      );
    }
    throw new ProdxivApiError(
      response.status,
      "network.invalid_response",
      `prodxiv API returned HTTP ${response.status} without a valid error body`,
    );
  }
  if (!isPublishedPaper(body)) {
    throw new ProdxivApiError(
      response.status,
      "network.invalid_response",
      "prodxiv API returned an invalid publication body",
    );
  }
  return body;
}

function paperList(response: Response, body: unknown): PaperList {
  if (!response.ok) {
    if (isErrorResponse(body)) {
      throw new ProdxivApiError(
        response.status,
        body.error.code,
        body.error.message,
        body.error.diagnostics ?? [],
      );
    }
    throw new ProdxivApiError(
      response.status,
      "network.invalid_response",
      `prodxiv API returned HTTP ${response.status} without a valid error body`,
    );
  }
  if (
    !isRecord(body) ||
    !Array.isArray(body.papers) ||
    !body.papers.every(isPublishedPaperSummary) ||
    !(
      body.next_cursor === undefined ||
      (typeof body.next_cursor === "string" && body.next_cursor.length > 0)
    )
  ) {
    throw new ProdxivApiError(
      response.status,
      "network.invalid_response",
      "prodxiv API returned an invalid paper list",
    );
  }
  return {
    papers: body.papers,
    ...(body.next_cursor === undefined
      ? {}
      : { next_cursor: body.next_cursor }),
  };
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  if (!isRecord(value) || !isRecord(value.error)) {
    return false;
  }
  return (
    typeof value.error.code === "string" &&
    typeof value.error.message === "string" &&
    (value.error.diagnostics === undefined ||
      Array.isArray(value.error.diagnostics))
  );
}

function isPublishedPaper(value: unknown): value is PublishedPaper {
  if (!isRecord(value)) {
    return false;
  }
  const record = value;
  return (
    isPublishedPaperSummary(value) && typeof record.source_markdown === "string"
  );
}

function isPublishedPaperSummary(
  value: unknown,
): value is PublishedPaperSummary {
  if (!isRecord(value) || !isRecord(value.metadata)) {
    return false;
  }
  const metadata = value.metadata;
  return (
    isNonEmptyString(value.schema_version) &&
    isNonEmptyString(value.paper_id) &&
    isNonEmptyString(value.product_id) &&
    Number.isInteger(value.version) &&
    (value.version as number) > 0 &&
    isDateString(value.published_at) &&
    metadata.schema_version === value.schema_version &&
    metadata.paper_id === value.paper_id &&
    metadata.version === value.version &&
    metadata.published_at === value.published_at &&
    isNonEmptyString(metadata.title) &&
    isOptionalString(metadata.product_name) &&
    (metadata.scope === undefined || isPaperScope(metadata.scope)) &&
    isNonEmptyString(metadata.summary) &&
    isProductStatus(metadata.status) &&
    isNonEmptyString(metadata.license) &&
    isOptionalString(metadata.organization) &&
    isOptionalString(metadata.product_url) &&
    isOptionalString(metadata.repository_url) &&
    Array.isArray(metadata.authors) &&
    metadata.authors.length > 0 &&
    metadata.authors.every(isAuthor) &&
    Array.isArray(metadata.topics) &&
    metadata.topics.length > 0 &&
    metadata.topics.every(isNonEmptyString) &&
    (metadata.relationships === undefined ||
      (Array.isArray(metadata.relationships) &&
        metadata.relationships.every(isRelationship)))
  );
}

function isPaperScope(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "product") {
    return value.name === undefined && value.product_version === undefined;
  }
  if (value.kind === "feature") {
    return (
      isNonEmptyString(value.name) && isOptionalString(value.product_version)
    );
  }
  return (
    value.kind === "release" &&
    isOptionalString(value.name) &&
    isNonEmptyString(value.product_version)
  );
}

function isAuthor(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.name) &&
    isOptionalString(value.affiliation) &&
    isOptionalString(value.url)
  );
}

function isRelationship(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.paper_id) &&
    (value.kind === "inspired_by" ||
      value.kind === "built_on" ||
      value.kind === "alternative_to" ||
      value.kind === "supersedes")
  );
}

function isProductStatus(value: unknown): boolean {
  return (
    value === "concept" ||
    value === "private_beta" ||
    value === "public_beta" ||
    value === "launched" ||
    value === "discontinued"
  );
}

function isDateString(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.valueOf()) &&
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
