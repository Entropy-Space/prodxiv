import { ProdxivApiError } from "../../packages/api-client/src/client.ts";

export type TranslationStage =
  | "startup"
  | "load_jobs"
  | "source"
  | "translate"
  | "save_translation"
  | "record_failure";

const WORKER_MESSAGES = {
  "translation.invalid_source":
    "The archived source has no valid front matter.",
  "translation.source_digest_mismatch":
    "The archived source digest does not match the job.",
  "translation.output_too_large":
    "The model response exceeds the translation size limit.",
  "translation.invalid_json": "The model response is not a JSON object.",
  "translation.invalid_fields":
    "The model response must contain exactly non-empty title, summary, and markdown strings.",
} as const;

export class TranslationWorkerError extends Error {
  constructor(readonly code: keyof typeof WORKER_MESSAGES) {
    super(WORKER_MESSAGES[code]);
    this.name = "TranslationWorkerError";
  }
}

export interface TranslationDiagnostic {
  stage: TranslationStage;
  code: string;
  message: string;
  http_status?: number;
}

const API_MESSAGES = new Map([
  ["auth.unauthorized", "The API rejected the authentication token."],
  ["auth.token_missing", "No API authentication token is configured."],
  [
    "auth.token_refresh_failed",
    "A fresh API authentication token could not be obtained.",
  ],
  [
    "auth.identity_provider_unavailable",
    "The API could not verify GitHub Actions identity.",
  ],
  [
    "translation.bot_required",
    "Translation operations require the bot principal.",
  ],
  [
    "translation.invalid_request",
    "The API rejected the translation request format.",
  ],
  [
    "translation.invalid",
    "The API rejected the translation's source or protected content.",
  ],
  [
    "network.request_failed",
    "The API request failed before a response was received.",
  ],
  ["network.invalid_response", "The API returned an invalid response."],
  ["storage.internal", "The API could not persist the translation result."],
]);

// Only these fixed, server-owned messages may enter the public Actions summary.
// Never serialize arbitrary error messages, response bodies, or model output.
const TRANSLATION_REJECTIONS = new Set([
  "translation fields are empty or exceed their size limits",
  "translation source digest is invalid",
  "translation changed headings, links, code, or embedded HTML structure",
  "language mismatch",
  "source digest mismatch",
  "paper revision does not exist",
  "revision was not enrolled for translation",
]);

export function translationDiagnostic(
  error: unknown,
  stage: TranslationStage,
): TranslationDiagnostic {
  if (error instanceof TranslationWorkerError) {
    return { stage, code: error.code, message: WORKER_MESSAGES[error.code] };
  }
  if (error instanceof ProdxivApiError) {
    const knownMessage = API_MESSAGES.get(error.code);
    return {
      stage,
      code: knownMessage === undefined ? "api.request_failed" : error.code,
      message:
        error.code === "translation.invalid" &&
        TRANSLATION_REJECTIONS.has(error.message)
          ? error.message
          : (knownMessage ?? "The API request failed."),
      ...(Number.isInteger(error.status) &&
      error.status >= 100 &&
      error.status <= 599
        ? { http_status: error.status }
        : {}),
    };
  }
  return {
    stage,
    code:
      stage === "translate"
        ? "translation.model_failed"
        : "translation.worker_failed",
    message:
      stage === "translate"
        ? "The translation model session failed; inspect its private session artifact."
        : "The translation worker could not complete this operation.",
  };
}
