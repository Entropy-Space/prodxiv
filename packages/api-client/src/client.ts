import type { components } from "./generated/api.ts";

export type PublishedPaper = components["schemas"]["PublishedPaper"];
type ErrorResponse = components["schemas"]["ErrorResponse"];
type ErrorDiagnostics = NonNullable<ErrorResponse["error"]["diagnostics"]>;

export interface PublishPaperInput {
  source_markdown: string;
  idempotency_key: string;
}

export interface PublishPaperResult {
  paper: PublishedPaper;
  location: string;
  replayed: boolean;
}

export type ApiFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ProdxivApiClientOptions {
  api_url: string;
  token: string;
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
  readonly #token: string;
  readonly #fetch: ApiFetch;

  constructor(options: ProdxivApiClientOptions) {
    this.#apiUrl = options.api_url.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async publishPaper(input: PublishPaperInput): Promise<PublishPaperResult> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiUrl}/v1/papers`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
          "idempotency-key": input.idempotency_key,
        },
        body: JSON.stringify({
          source_markdown: input.source_markdown,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProdxivApiError(
        0,
        "network.request_failed",
        `publishing request failed: ${message}`,
      );
    }

    const body = (await response.json().catch(() => undefined)) as
      PublishedPaper | ErrorResponse | undefined;
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
        `publishing API returned HTTP ${response.status} without a valid error body`,
      );
    }
    if (!isPublishedPaper(body)) {
      throw new ProdxivApiError(
        response.status,
        "network.invalid_response",
        "publishing API returned an invalid publication body",
      );
    }

    return {
      paper: body,
      location:
        response.headers.get("location") ??
        `/v1/papers/${body.paper_id}/versions/${body.version}`,
      replayed: response.status === 200,
    };
  }
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
  return (
    isRecord(value) &&
    typeof value.paper_id === "string" &&
    typeof value.version === "number" &&
    typeof value.published_at === "string" &&
    typeof value.source_markdown === "string" &&
    isRecord(value.metadata)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
