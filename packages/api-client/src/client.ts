import type { components } from "./generated/api.ts";
import { paperSlugFromCanonicalId } from "./public-paper-url.ts";

export type PaperMetadata = components["schemas"]["PaperMetadata"];
export type PublishedPaper = components["schemas"]["PublishedPaper"];
export type PublishedPaperSummary =
  components["schemas"]["PublishedPaperSummary"];
export type PaperDraft = components["schemas"]["PaperDraft"];
export type PaperDraftSummary = components["schemas"]["PaperDraftSummary"];
export type DraftReviewStatus = components["schemas"]["DraftReviewStatus"];
export type DraftOwnerKind = components["schemas"]["DraftOwnerKind"];
export type PaperDraftRevision = components["schemas"]["PaperDraftRevision"];
export type PaperDraftRevisionSummary =
  components["schemas"]["PaperDraftRevisionSummary"];
export type PublicPaperDraft = components["schemas"]["PublicPaperDraft"];
export type PublicPaperDraftSummary =
  components["schemas"]["PublicPaperDraftSummary"];
export type PublicPaperDraftResponse =
  components["schemas"]["PublicPaperDraftResponse"];
export type GitHubTrendingEntry =
  components["schemas"]["GitHubTrendingEntryResponse"];
export type GitHubTrendingSnapshot =
  components["schemas"]["GitHubTrendingSnapshotResponse"];
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
  q?: string;
  topic?: string;
}

export interface PaperList {
  papers: PublishedPaperSummary[];
  next_cursor?: string;
}

export interface PaperRevisionList {
  revisions: PublishedPaperSummary[];
}

export interface PaperTopicList {
  topics: string[];
}

export interface ListPublicDraftsInput {
  limit?: number;
  cursor?: string;
}

export interface PublicPaperDraftList {
  drafts: PublicPaperDraftSummary[];
  next_cursor?: string;
}

export interface CreateDraftInput {
  source_markdown: string;
  idempotency_key: string;
}

export interface UpdateDraftInput {
  source_markdown: string;
  expected_revision: number;
}

export interface PublishDraftInput {
  expected_revision: number;
  idempotency_key: string;
  product_id?: string;
}

export interface ReviewDraftInput {
  expected_revision: number;
}

export interface RejectDraftInput extends ReviewDraftInput {
  reason?: string;
}

export interface ListDraftsInput {
  limit?: number;
  review_status?: DraftReviewStatus;
  owner_kind?: DraftOwnerKind;
}

export interface PaperDraftList {
  drafts: PaperDraftSummary[];
}

export interface PaperDraftRevisionList {
  revisions: PaperDraftRevisionSummary[];
  retained_revision_limit: number;
}

export interface GetGitHubTrendingInput {
  date?: string;
  period?: "daily" | "weekly" | "monthly";
  language?: string;
  spoken_language?: string;
}

export interface GitHubTrendingView {
  requested_language: string;
  snapshots: GitHubTrendingSnapshot[];
  previous_date?: string;
  next_date?: string;
  available_languages: string[];
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

  async listPublicDrafts(
    input: ListPublicDraftsInput = {},
  ): Promise<PublicPaperDraftList> {
    const query = paginationQuery(input, "draft");
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const { response, body } = await this.#publicRequest(
      `/v1/public/drafts${suffix}`,
    );
    return publicPaperDraftList(response, body);
  }

  async getPublicDraft(paperUuid: string): Promise<PublicPaperDraftResponse> {
    validateDraftUuid(paperUuid);
    const path = `/v1/public/drafts/${paperUuid}`;
    const { response, body } = await this.#publicRequest(path);
    return publicPaperDraftResponse(response, body, paperUuid);
  }

  async createDraft(input: CreateDraftInput): Promise<PaperDraft> {
    validateDraftSource(input.source_markdown);
    const { response, body } = await this.#request("/v1/drafts", {
      method: "POST",
      headers: {
        authorization: this.#draftAuthorization(),
        "content-type": "application/json",
        "idempotency-key": input.idempotency_key,
      },
      body: JSON.stringify({ source_markdown: input.source_markdown }),
    });
    return paperDraft(response, body);
  }

  async listDrafts(input: ListDraftsInput = {}): Promise<PaperDraftList> {
    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    ) {
      throw new ProdxivApiError(
        0,
        "request.invalid_limit",
        "draft list limit must be an integer between 1 and 100",
      );
    }
    if (
      input.review_status !== undefined &&
      !isDraftReviewStatus(input.review_status)
    ) {
      throw new ProdxivApiError(
        0,
        "draft.invalid_review_status",
        "draft review status must be pending_review, approved, or rejected",
      );
    }
    if (input.owner_kind !== undefined && !isDraftOwnerKind(input.owner_kind)) {
      throw new ProdxivApiError(
        0,
        "draft.invalid_owner_kind",
        "draft owner kind must be author or bot",
      );
    }
    const query = new URLSearchParams();
    if (input.limit !== undefined) {
      query.set("limit", String(input.limit));
    }
    if (input.review_status !== undefined) {
      query.set("review_status", input.review_status);
    }
    if (input.owner_kind !== undefined) {
      query.set("owner_kind", input.owner_kind);
    }
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const { response, body } = await this.#request(`/v1/drafts${suffix}`, {
      headers: { authorization: this.#draftAuthorization() },
    });
    return paperDraftList(response, body);
  }

  async getDraft(paperUuid: string): Promise<PaperDraft> {
    const path = draftPath(paperUuid);
    const { response, body } = await this.#request(path, {
      headers: { authorization: this.#draftAuthorization() },
    });
    return paperDraft(response, body);
  }

  async updateDraft(
    paperUuid: string,
    input: UpdateDraftInput,
  ): Promise<PaperDraft> {
    validateDraftSource(input.source_markdown);
    validateDraftRevision(input.expected_revision);
    const { response, body } = await this.#request(draftPath(paperUuid), {
      method: "PUT",
      headers: {
        authorization: this.#draftAuthorization(),
        "content-type": "application/json",
        "if-match": `"${input.expected_revision}"`,
      },
      body: JSON.stringify({ source_markdown: input.source_markdown }),
    });
    return paperDraft(response, body);
  }

  async approveDraft(
    paperUuid: string,
    input: ReviewDraftInput,
  ): Promise<PaperDraft> {
    validateDraftRevision(input.expected_revision);
    const { response, body } = await this.#request(
      `${draftPath(paperUuid)}/approve`,
      {
        method: "POST",
        headers: {
          authorization: this.#draftAuthorization(),
          "if-match": `"${input.expected_revision}"`,
        },
      },
    );
    return paperDraft(response, body);
  }

  async rejectDraft(
    paperUuid: string,
    input: RejectDraftInput,
  ): Promise<PaperDraft> {
    validateDraftRevision(input.expected_revision);
    if (
      input.reason !== undefined &&
      new TextEncoder().encode(input.reason).byteLength > 2_000
    ) {
      throw new ProdxivApiError(
        0,
        "draft.rejection_reason_too_large",
        "draft rejection reason must not exceed 2000 bytes",
      );
    }
    const { response, body } = await this.#request(
      `${draftPath(paperUuid)}/reject`,
      {
        method: "POST",
        headers: {
          authorization: this.#draftAuthorization(),
          "content-type": "application/json",
          "if-match": `"${input.expected_revision}"`,
        },
        body: JSON.stringify(
          input.reason === undefined ? {} : { reason: input.reason },
        ),
      },
    );
    return paperDraft(response, body);
  }

  async deleteDraft(
    paperUuid: string,
    expectedRevision: number,
  ): Promise<void> {
    validateDraftRevision(expectedRevision);
    const { response, body } = await this.#request(draftPath(paperUuid), {
      method: "DELETE",
      headers: {
        authorization: this.#draftAuthorization(),
        "if-match": `"${expectedRevision}"`,
      },
    });
    assertSuccessfulResponse(response, body);
  }

  async listDraftRevisions(paperUuid: string): Promise<PaperDraftRevisionList> {
    const { response, body } = await this.#request(
      `${draftPath(paperUuid)}/revisions`,
      { headers: { authorization: this.#draftAuthorization() } },
    );
    return paperDraftRevisionList(response, body);
  }

  async getDraftRevision(
    paperUuid: string,
    revision: number,
  ): Promise<PaperDraftRevision> {
    validateDraftRevision(revision);
    const { response, body } = await this.#request(
      `${draftPath(paperUuid)}/revisions/${revision}`,
      { headers: { authorization: this.#draftAuthorization() } },
    );
    return paperDraftRevision(response, body);
  }

  async publishDraft(
    paperUuid: string,
    input: PublishDraftInput,
  ): Promise<PublishPaperResult> {
    validateDraftRevision(input.expected_revision);
    const { response, body } = await this.#request(
      `${draftPath(paperUuid)}/publish`,
      {
        method: "POST",
        headers: {
          authorization: this.#draftAuthorization(),
          "content-type": "application/json",
          "idempotency-key": input.idempotency_key,
          "if-match": `"${input.expected_revision}"`,
        },
        body: JSON.stringify(
          input.product_id === undefined
            ? {}
            : { product_id: input.product_id },
        ),
      },
    );
    return publishPaperResult(response, body);
  }

  async approveAndPublishDraft(
    paperUuid: string,
    input: PublishDraftInput,
  ): Promise<PublishPaperResult> {
    validateDraftRevision(input.expected_revision);
    const { response, body } = await this.#request(
      `${draftPath(paperUuid)}/approve-and-publish`,
      {
        method: "POST",
        headers: {
          authorization: this.#draftAuthorization(),
          "content-type": "application/json",
          "idempotency-key": input.idempotency_key,
          "if-match": `"${input.expected_revision}"`,
        },
        body: JSON.stringify(
          input.product_id === undefined
            ? {}
            : { product_id: input.product_id },
        ),
      },
    );
    return publishPaperResult(response, body);
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

    return publishPaperResult(response, body);
  }

  async getPaperRevision(
    paperId: string,
    revision: number,
  ): Promise<PublishedPaper> {
    validatePaperId(paperId);
    if (!isPaperRevision(revision)) {
      throw new ProdxivApiError(
        0,
        "request.invalid_revision",
        "paper revision must be an integer between 1 and 4294967295",
      );
    }
    const path = `/v1/papers/${encodeURIComponent(paperId)}/revisions/${revision}`;
    const { response, body } = await this.#publicRequest(path);
    const paper = publishedPaper(response, body);
    if (paper.paper_id !== paperId || paper.version !== revision) {
      throw invalidResponse(
        response,
        "prodxiv API returned a different paper identifier or revision",
      );
    }
    return paper;
  }

  async listPaperRevisions(paperId: string): Promise<PaperRevisionList> {
    validatePaperId(paperId);
    const { response, body } = await this.#publicRequest(
      `/v1/papers/${encodeURIComponent(paperId)}/revisions`,
    );
    assertSuccessfulResponse(response, body);
    if (
      !isRecord(body) ||
      !Array.isArray(body.revisions) ||
      body.revisions.length === 0 ||
      !body.revisions.every(isPublishedPaperSummary) ||
      body.revisions.some((paper) => paper.paper_id !== paperId) ||
      new Set(body.revisions.map((paper) => paper.version)).size !==
        body.revisions.length
    ) {
      throw invalidResponse(
        response,
        "prodxiv API returned an invalid paper revision history",
      );
    }
    return {
      revisions: body.revisions.toSorted(
        (left, right) => right.version - left.version,
      ),
    };
  }

  async listPaperTopics(): Promise<PaperTopicList> {
    const { response, body } = await this.#publicRequest("/v1/papers/topics");
    assertSuccessfulResponse(response, body);
    if (
      !isRecord(body) ||
      !Array.isArray(body.topics) ||
      !body.topics.every(isStoredTopic) ||
      new Set(body.topics).size !== body.topics.length
    ) {
      throw invalidResponse(
        response,
        "prodxiv API returned an invalid topic list",
      );
    }
    return { topics: body.topics };
  }

  /** @deprecated Use getPaperRevision. */
  async getPaperVersion(
    paperId: string,
    version: number,
  ): Promise<PublishedPaper> {
    return this.getPaperRevision(paperId, version);
  }

  async listPapers(input: ListPapersInput = {}): Promise<PaperList> {
    const query = paginationQuery(input, "paper");
    const search = normalizeFilter(input.q, 200, "query");
    const topic = normalizeFilter(input.topic, 100, "topic");
    if (search !== undefined) query.set("q", search);
    if (topic !== undefined) {
      if (!isStoredTopic(topic)) {
        throw new ProdxivApiError(
          0,
          "request.invalid_topic",
          "paper topic must use lowercase snake_case",
        );
      }
      query.set("topic", topic);
    }
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const { response, body } = await this.#publicRequest(`/v1/papers${suffix}`);
    return paperList(response, body);
  }

  async getGitHubTrending(
    input: GetGitHubTrendingInput = {},
  ): Promise<GitHubTrendingView> {
    const query = new URLSearchParams();
    if (input.date !== undefined) {
      query.set("date", input.date);
    }
    if (input.period !== undefined) {
      query.set("period", input.period);
    }
    if (input.language !== undefined) {
      query.set("language", input.language);
    }
    if (input.spoken_language !== undefined) {
      query.set("spoken_language", input.spoken_language);
    }
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const { response, body } = await this.#publicRequest(
      `/v1/github/trending${suffix}`,
    );
    const view = githubTrending(response, body);
    const requested_language = input.language?.trim().toLowerCase() || "any";
    if (view.requested_language !== requested_language) {
      throw new ProdxivApiError(
        response.status,
        "network.invalid_response",
        "prodxiv API returned a different GitHub Trending language selector",
      );
    }
    return view;
  }

  async #publicRequest(
    path: string,
  ): Promise<{ response: Response; body: unknown }> {
    let url: URL;
    try {
      url = new URL(this.#apiUrl);
    } catch {
      throw new ProdxivApiError(
        0,
        "request.invalid_api_url",
        "API URL is invalid",
      );
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new ProdxivApiError(
        0,
        "request.invalid_api_url",
        "public API reads require an anonymous HTTP(S) base URL",
      );
    }
    return this.#request(path, {
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
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

  #draftAuthorization(): string {
    if (this.#token === undefined || this.#token.length === 0) {
      throw new ProdxivApiError(
        0,
        "auth.token_missing",
        "draft access requires a bearer token",
      );
    }
    return `Bearer ${this.#token}`;
  }
}

function publishPaperResult(
  response: Response,
  body: unknown,
): PublishPaperResult {
  const paper = publishedPaper(response, body);
  return {
    paper,
    location:
      response.headers.get("location") ??
      `/v1/papers/${paper.paper_id}/revisions/${paper.version}`,
    replayed: response.status === 200,
  };
}

function paperDraft(response: Response, body: unknown): PaperDraft {
  assertSuccessfulResponse(response, body);
  if (!isPaperDraft(body)) {
    throw invalidResponse(
      response,
      "prodxiv API returned an invalid draft body",
    );
  }
  return body;
}

function publicPaperDraftList(
  response: Response,
  body: unknown,
): PublicPaperDraftList {
  assertSuccessfulResponse(response, body);
  if (
    !isRecord(body) ||
    !Array.isArray(body.drafts) ||
    !body.drafts.every(isPublicPaperDraftSummary) ||
    new Set(body.drafts.map((draft) => draft.paper_uuid)).size !==
      body.drafts.length ||
    !(isAbsent(body.next_cursor) || isCursor(body.next_cursor))
  ) {
    throw invalidResponse(
      response,
      "prodxiv API returned an invalid public draft list",
    );
  }
  return {
    drafts: body.drafts.map(publicDraftSummary),
    ...(isAbsent(body.next_cursor)
      ? {}
      : { next_cursor: body.next_cursor as string }),
  };
}

function publicPaperDraftResponse(
  response: Response,
  body: unknown,
  paperUuid: string,
): PublicPaperDraftResponse {
  assertSuccessfulResponse(response, body);
  if (isRecord(body) && body.kind === "published") {
    if (isCanonicalPaperId(body.paper_id) && isPaperRevision(body.version)) {
      return {
        kind: "published",
        paper_id: body.paper_id,
        version: body.version,
      };
    }
  }
  if (
    isRecord(body) &&
    body.kind === "draft" &&
    isPublicPaperDraft(body.draft) &&
    body.draft.paper_uuid === paperUuid
  ) {
    return {
      kind: "draft",
      draft: {
        ...publicDraftSummary(body.draft),
        source_markdown: body.draft.source_markdown,
      },
    };
  }
  throw invalidResponse(
    response,
    "prodxiv API returned an invalid public draft",
  );
}

function isPublicPaperDraft(value: unknown): value is PublicPaperDraft {
  return (
    isRecord(value) &&
    typeof value.source_markdown === "string" &&
    value.source_markdown.trim().length > 0 &&
    new TextEncoder().encode(value.source_markdown).byteLength <=
      2 * 1024 * 1024 &&
    isPublicPaperDraftSummary(value)
  );
}

function isPublicPaperDraftSummary(
  value: unknown,
): value is PublicPaperDraftSummary {
  return (
    isRecord(value) &&
    isCanonicalUuid(value.paper_uuid) &&
    isPositiveSafeInteger(value.revision) &&
    isDraftOwnerKind(value.owner_kind) &&
    value.review_status === "pending_review" &&
    isTimestamp(value.updated_at) &&
    (isAbsent(value.metadata) ||
      (isPaperMetadata(value.metadata) &&
        value.metadata.topics.every(isTopic) &&
        hasAnonymousMetadataLinks(value.metadata)))
  );
}

function publicDraftSummary(
  draft: PublicPaperDraftSummary,
): PublicPaperDraftSummary {
  // Whitelist the public DTO: a management response must never leak review
  // actors, rejection notes, retained snapshots, or other unexpected fields.
  return {
    paper_uuid: draft.paper_uuid,
    revision: draft.revision,
    owner_kind: draft.owner_kind,
    review_status: draft.review_status,
    updated_at: draft.updated_at,
    ...(draft.metadata == null ? {} : { metadata: draft.metadata }),
  };
}

function hasAnonymousMetadataLinks(metadata: PaperMetadata): boolean {
  const evidence =
    typeof metadata.status === "string" ? [] : (metadata.status.evidence ?? []);
  const links = [
    metadata.product_url,
    metadata.repository_url,
    ...metadata.authors.map((author) => author.url),
    ...evidence.map((item) => item.url),
  ];
  return links.every((value) => {
    if (value == null) return true;
    // Structural URL validation has already succeeded. Only the mutable
    // public-draft projection imposes this additional anonymous-link rule.
    const url = new URL(value);
    return url.username === "" && url.password === "";
  });
}

function paperDraftList(response: Response, body: unknown): PaperDraftList {
  assertSuccessfulResponse(response, body);
  if (
    !isRecord(body) ||
    !Array.isArray(body.drafts) ||
    !body.drafts.every(isPaperDraftSummary)
  ) {
    throw invalidResponse(
      response,
      "prodxiv API returned an invalid draft list",
    );
  }
  return { drafts: body.drafts };
}

function paperDraftRevision(
  response: Response,
  body: unknown,
): PaperDraftRevision {
  assertSuccessfulResponse(response, body);
  if (!isPaperDraftRevision(body)) {
    throw invalidResponse(
      response,
      "prodxiv API returned an invalid draft revision",
    );
  }
  return body;
}

function paperDraftRevisionList(
  response: Response,
  body: unknown,
): PaperDraftRevisionList {
  assertSuccessfulResponse(response, body);
  if (
    !isRecord(body) ||
    !Number.isInteger(body.retained_revision_limit) ||
    (body.retained_revision_limit as number) < 1 ||
    !Array.isArray(body.revisions) ||
    !body.revisions.every(isPaperDraftRevisionSummary) ||
    body.revisions.length > (body.retained_revision_limit as number)
  ) {
    throw invalidResponse(
      response,
      "prodxiv API returned an invalid draft revision list",
    );
  }
  return {
    revisions: body.revisions,
    retained_revision_limit: body.retained_revision_limit as number,
  };
}

function assertSuccessfulResponse(response: Response, body: unknown): void {
  if (response.ok) {
    return;
  }
  if (isErrorResponse(body)) {
    throw new ProdxivApiError(
      response.status,
      body.error.code,
      body.error.message,
      body.error.diagnostics ?? [],
    );
  }
  throw invalidResponse(
    response,
    `prodxiv API returned HTTP ${response.status} without a valid error body`,
  );
}

function invalidResponse(response: Response, message: string): ProdxivApiError {
  return new ProdxivApiError(
    response.status,
    "network.invalid_response",
    message,
  );
}

function isPaperDraft(value: unknown): value is PaperDraft {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.source_markdown === "string" &&
    value.source_markdown.length > 0 &&
    isPaperDraftSummary(value)
  );
}

function isPaperDraftSummary(value: unknown): value is PaperDraftSummary {
  return (
    isRecord(value) &&
    isCanonicalUuid(value.paper_uuid) &&
    isPositiveSafeInteger(value.revision) &&
    isDraftOwnerKind(value.owner_kind) &&
    isPaperDraftReview(value.review, value.revision as number) &&
    isTimestamp(value.created_at) &&
    isTimestamp(value.updated_at)
  );
}

function isPaperDraftReview(value: unknown, currentRevision: number): boolean {
  if (!isRecord(value) || !isDraftReviewStatus(value.status)) {
    return false;
  }
  const reviewedRevision = value.reviewed_revision;
  const reviewedBy = value.reviewed_by;
  const reviewedAt = value.reviewed_at;
  const rejectionReason = value.rejection_reason;
  if (value.status === "pending_review") {
    return (
      isAbsent(reviewedRevision) &&
      isAbsent(reviewedBy) &&
      isAbsent(reviewedAt) &&
      isAbsent(rejectionReason)
    );
  }
  if (
    !isPositiveSafeInteger(reviewedRevision) ||
    reviewedRevision !== currentRevision ||
    typeof reviewedBy !== "string" ||
    reviewedBy.trim().length === 0 ||
    !isTimestamp(reviewedAt)
  ) {
    return false;
  }
  return value.status === "approved"
    ? isAbsent(rejectionReason)
    : isAbsent(rejectionReason) || typeof rejectionReason === "string";
}

function isDraftReviewStatus(value: unknown): value is DraftReviewStatus {
  return (
    value === "pending_review" || value === "approved" || value === "rejected"
  );
}

function isDraftOwnerKind(value: unknown): value is DraftOwnerKind {
  return value === "author" || value === "bot";
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

function isPaperDraftRevision(value: unknown): value is PaperDraftRevision {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.source_markdown === "string" &&
    value.source_markdown.length > 0 &&
    isPaperDraftRevisionSummary(value)
  );
}

function isPaperDraftRevisionSummary(
  value: unknown,
): value is PaperDraftRevisionSummary {
  return (
    isRecord(value) &&
    isCanonicalUuid(value.paper_uuid) &&
    isPositiveSafeInteger(value.revision) &&
    isTimestamp(value.created_at)
  );
}

function draftPath(paperUuid: string): string {
  validateDraftUuid(paperUuid);
  return `/v1/drafts/${paperUuid}`;
}

function validateDraftUuid(paperUuid: string): void {
  if (!isCanonicalUuid(paperUuid)) {
    throw new ProdxivApiError(
      0,
      "draft.invalid_uuid",
      "paper UUID must use canonical lowercase hyphenated notation",
    );
  }
}

function paginationQuery(
  input: ListPublicDraftsInput,
  kind: "draft" | "paper",
): URLSearchParams {
  if (
    input.limit !== undefined &&
    (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
  ) {
    throw new ProdxivApiError(
      0,
      "request.invalid_limit",
      `${kind} list limit must be an integer between 1 and 100`,
    );
  }
  if (input.cursor !== undefined && !isCursor(input.cursor)) {
    throw new ProdxivApiError(
      0,
      "request.invalid_cursor",
      `${kind} list cursor must be a nonempty opaque value of at most 4096 characters`,
    );
  }
  const query = new URLSearchParams();
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  if (input.cursor !== undefined) query.set("cursor", input.cursor);
  return query;
}

function normalizeFilter(
  value: string | undefined,
  maximumLength: number,
  name: "query" | "topic",
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    Array.from(value).length > maximumLength ||
    /[\p{Cc}]/u.test(value)
  ) {
    throw new ProdxivApiError(
      0,
      `request.invalid_${name}`,
      `paper ${name} must not contain control characters or exceed ${maximumLength} characters`,
    );
  }
  return value.trim() || undefined;
}

function isCursor(value: unknown): value is string {
  return (
    isNonEmptyString(value) && value.length <= 4096 && !/[\p{Cc}]/u.test(value)
  );
}

function isTopic(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(value);
}

function isStoredTopic(value: unknown): value is string {
  // Older authoritative validation accepted repeated internal underscores.
  // Preserve immutable topics in reads and literal filters; new draft
  // projections use the current stricter schema above.
  return typeof value === "string" && /^[a-z0-9]+(?:_+[a-z0-9]+)*$/.test(value);
}

function validatePaperId(paperId: string): void {
  if (!isCanonicalPaperId(paperId)) {
    throw new ProdxivApiError(
      0,
      "request.invalid_paper_id",
      "paper identifier must use canonical prodxiv notation",
    );
  }
}

function isCanonicalPaperId(value: unknown): value is string {
  return (
    typeof value === "string" && paperSlugFromCanonicalId(value) !== undefined
  );
}

function isMetadataPaperId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^prodxiv:[0-9]{4}\.[a-zA-Z0-9]{6}$/.test(value)
  ) {
    return false;
  }
  // Draft metadata and relationships may use lowercase Crockford suffixes.
  // Keep the original metadata intact, while root publication identity and
  // all generated reader URLs continue to require canonical uppercase.
  return isCanonicalPaperId(
    "prodxiv:" + value.slice("prodxiv:".length).toUpperCase(),
  );
}

function isPaperRevision(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= 4_294_967_295
  );
}

function validateDraftRevision(revision: number): void {
  if (!isPositiveSafeInteger(revision)) {
    throw new ProdxivApiError(
      0,
      "draft.invalid_revision",
      "draft revision must be a positive safe integer",
    );
  }
}

function validateDraftSource(sourceMarkdown: string): void {
  if (sourceMarkdown.trim().length === 0) {
    throw new ProdxivApiError(
      0,
      "draft.source_required",
      "draft source Markdown must not be empty",
    );
  }
  if (new TextEncoder().encode(sourceMarkdown).byteLength > 2 * 1024 * 1024) {
    throw new ProdxivApiError(
      0,
      "draft.source_too_large",
      "draft source Markdown must not exceed 2097152 bytes",
    );
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= 2_147_483_647
  );
}

function isCanonicalUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
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

function githubTrending(response: Response, body: unknown): GitHubTrendingView {
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
    !isGitHubTrendingLanguageSelector(body.requested_language) ||
    !Array.isArray(body.snapshots) ||
    !body.snapshots.every(isGitHubTrendingSnapshot) ||
    (body.requested_language !== "all" &&
      (body.snapshots.length > 1 ||
        body.snapshots.some(
          (snapshot) => snapshot.language !== body.requested_language,
        ))) ||
    !isOptionalDateString(body.previous_date) ||
    !isOptionalDateString(body.next_date) ||
    !Array.isArray(body.available_languages) ||
    !body.available_languages.every(isConcreteGitHubTrendingLanguage)
  ) {
    throw new ProdxivApiError(
      response.status,
      "network.invalid_response",
      "prodxiv API returned an invalid GitHub Trending snapshot",
    );
  }
  return {
    requested_language: body.requested_language,
    snapshots: body.snapshots,
    ...(body.previous_date === undefined || body.previous_date === null
      ? {}
      : { previous_date: body.previous_date }),
    ...(body.next_date === undefined || body.next_date === null
      ? {}
      : { next_date: body.next_date }),
    available_languages: body.available_languages,
  };
}

function isGitHubTrendingSnapshot(
  value: unknown,
): value is GitHubTrendingSnapshot {
  return (
    isRecord(value) &&
    isDateString(value.snapshot_date) &&
    isOptionalString(value.captured_at) &&
    (value.period === "daily" ||
      value.period === "weekly" ||
      value.period === "monthly") &&
    isGitHubTrendingLanguageScope(value.language) &&
    isOptionalString(value.spoken_language) &&
    isNonEmptyString(value.source_kind) &&
    isNonEmptyString(value.source_url) &&
    isNonEmptyString(value.source_revision) &&
    Array.isArray(value.entries) &&
    value.entries.every(isGitHubTrendingEntry)
  );
}

function isGitHubTrendingLanguageSelector(value: unknown): value is string {
  return value === "all" || isGitHubTrendingLanguageScope(value);
}

function isGitHubTrendingLanguageScope(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 100 &&
    value !== "all" &&
    /^[a-z0-9#+.-]+$/.test(value)
  );
}

function isConcreteGitHubTrendingLanguage(value: unknown): value is string {
  return value !== "any" && isGitHubTrendingLanguageScope(value);
}

function isGitHubTrendingEntry(value: unknown): value is GitHubTrendingEntry {
  return (
    isRecord(value) &&
    Number.isInteger(value.rank) &&
    (value.rank as number) > 0 &&
    isNonEmptyString(value.repository_full_name) &&
    isOptionalString(value.repository_node_id) &&
    isNonEmptyString(value.repository_url) &&
    isOptionalString(value.description) &&
    isOptionalString(value.primary_language) &&
    isOptionalNonNegativeInteger(value.stars) &&
    isOptionalNonNegativeInteger(value.forks) &&
    isOptionalNonNegativeInteger(value.stars_in_period)
  );
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
  if (!isRecord(value) || !isPaperMetadata(value.metadata)) {
    return false;
  }
  const metadata = value.metadata;
  return (
    isCanonicalPaperId(value.paper_id) &&
    isNonEmptyString(value.product_id) &&
    isPaperRevision(value.version) &&
    isDateString(value.published_at) &&
    metadata.schema_version === value.schema_version &&
    metadata.paper_id === value.paper_id &&
    metadata.version === value.version &&
    metadata.published_at === value.published_at &&
    isNonEmptyString(metadata.license)
  );
}

function isPaperMetadata(value: unknown): value is PaperMetadata {
  if (!isRecord(value)) return false;
  const metadata = value;
  return (
    (metadata.schema_version === "1" || metadata.schema_version === "2") &&
    (isAbsent(metadata.paper_id) || isMetadataPaperId(metadata.paper_id)) &&
    (isAbsent(metadata.version) || isPaperRevision(metadata.version)) &&
    isOptionalDateString(metadata.published_at) &&
    isNonEmptyString(metadata.title) &&
    (isAbsent(metadata.product_name) ||
      isNonEmptyString(metadata.product_name)) &&
    (isAbsent(metadata.scope) || isPaperScope(metadata.scope)) &&
    isNonEmptyString(metadata.summary) &&
    isProductStatus(metadata.status, metadata.schema_version) &&
    (isAbsent(metadata.license) || isNonEmptyString(metadata.license)) &&
    isOptionalString(metadata.organization) &&
    (isAbsent(metadata.product_url) || isHttpUrl(metadata.product_url)) &&
    (isAbsent(metadata.repository_url) || isHttpUrl(metadata.repository_url)) &&
    Array.isArray(metadata.authors) &&
    metadata.authors.length > 0 &&
    metadata.authors.every((author) =>
      isAuthor(author, metadata.schema_version),
    ) &&
    isWritersAndContact(metadata, metadata.schema_version) &&
    Array.isArray(metadata.topics) &&
    metadata.topics.length > 0 &&
    metadata.topics.every(isStoredTopic) &&
    new Set(metadata.topics).size === metadata.topics.length &&
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
    return isAbsent(value.name) && isAbsent(value.product_version);
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

function isAuthor(value: unknown, schemaVersion: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.name) &&
    (value.id == null || isNamespacedId(value.id)) &&
    (value.kind == null ||
      value.kind === "person" ||
      value.kind === "organization") &&
    (schemaVersion !== "2" ||
      value.kind === "person" ||
      value.kind === "organization") &&
    isOptionalString(value.affiliation) &&
    (isAbsent(value.url) || isHttpUrl(value.url))
  );
}

function isWritersAndContact(
  metadata: Record<string, unknown>,
  schemaVersion: unknown,
): boolean {
  if (schemaVersion === "1") {
    return (
      (metadata.writers === undefined ||
        (Array.isArray(metadata.writers) && metadata.writers.length === 0)) &&
      metadata.communication_email == null
    );
  }
  if (
    schemaVersion !== "2" ||
    !Array.isArray(metadata.writers) ||
    metadata.writers.length === 0 ||
    !metadata.writers.every(isWriter)
  ) {
    return false;
  }
  return (
    metadata.communication_email == null ||
    (isEmail(metadata.communication_email) &&
      metadata.writers.some(
        (writer) => isRecord(writer) && writer.kind === "human",
      ))
  );
}

function isWriter(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.name)) {
    return false;
  }
  if (value.kind === "human") {
    return (
      value.model == null &&
      value.tool_version == null &&
      value.generation_id == null
    );
  }
  return (
    value.kind === "agent" &&
    isNonEmptyString(value.model) &&
    (isAbsent(value.tool_version) || isNonEmptyString(value.tool_version)) &&
    (isAbsent(value.generation_id) || isNonEmptyString(value.generation_id))
  );
}

function isRelationship(value: unknown): boolean {
  return (
    isRecord(value) &&
    isMetadataPaperId(value.paper_id) &&
    (value.kind === "inspired_by" ||
      value.kind === "built_on" ||
      value.kind === "alternative_to" ||
      value.kind === "supersedes")
  );
}

function isProductStatus(value: unknown, schemaVersion: unknown): boolean {
  if (schemaVersion === "1") {
    return isProductStatusValue(value) && value !== "unknown";
  }
  if (
    schemaVersion !== "2" ||
    !isRecord(value) ||
    !isProductStatusValue(value.value) ||
    (value.determination !== "declared" &&
      value.determination !== "inferred" &&
      value.determination !== "unverified") ||
    (value.confidence !== "high" &&
      value.confidence !== "medium" &&
      value.confidence !== "low") ||
    (value.value === "unknown") !== (value.determination === "unverified") ||
    (value.observed_at != null && !isTimestamp(value.observed_at)) ||
    (value.evidence !== undefined &&
      (!Array.isArray(value.evidence) ||
        !value.evidence.every(isProductStatusEvidence)))
  ) {
    return false;
  }
  return (
    value.determination !== "inferred" ||
    (isTimestamp(value.observed_at) &&
      Array.isArray(value.evidence) &&
      value.evidence.length > 0)
  );
}

function isProductStatusValue(value: unknown): boolean {
  return (
    value === "unknown" ||
    value === "concept" ||
    value === "private_beta" ||
    value === "public_beta" ||
    value === "launched" ||
    value === "discontinued"
  );
}

function isProductStatusEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.kind === "github_release" &&
    isHttpUrl(value.url) &&
    (value.tag == null || isNonEmptyString(value.tag))
  );
}

function isNamespacedId(value: unknown): boolean {
  return (
    typeof value === "string" && /^[a-z][a-z0-9_-]*:[^\s:][^\s]*$/.test(value)
  );
}

function isTimestamp(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
  ) {
    return false;
  }
  const timestamp = new Date(value);
  return (
    !Number.isNaN(timestamp.valueOf()) &&
    timestamp.toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    // HTTP(S) URLs with userinfo were historically publication-valid. Reading
    // an immutable record must not retroactively apply a new authoring policy;
    // the public UI separately suppresses credential-bearing resource links.
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isEmail(value: unknown): boolean {
  if (typeof value !== "string" || value !== value.trim() || /\s/.test(value)) {
    return false;
  }
  const [local, domain, extra] = value.split("@");
  return (
    extra === undefined &&
    local !== undefined &&
    local.length > 0 &&
    domain !== undefined &&
    domain.length > 0 &&
    !domain.startsWith(".") &&
    !domain.endsWith(".")
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

function isOptionalDateString(
  value: unknown,
): value is string | null | undefined {
  return value === undefined || value === null || isDateString(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Number.isSafeInteger(value) && (value as number) >= 0)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
