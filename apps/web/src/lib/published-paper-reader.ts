import {
  ProdxivApiClient,
  ProdxivApiError,
  type ApiFetch,
  type PublishedPaper,
  type PublishedPaperSummary,
  type PaperTranslation,
  type PaperLanguage,
  isPaperLanguage,
} from "@prodxiv/api-client";
import { paperSlugFromCanonicalId } from "@prodxiv/api-client/public-paper-url";

import { configuredApiUrl } from "./api-url.ts";
import {
  PublishedPaperFormatError,
  renderPaperMarkdown,
  type RenderedPaperMarkdown,
} from "./render-paper-markdown.ts";

export interface PaperReaderError {
  status: number;
  title: string;
  message: string;
}

export type PaperReaderResult =
  | {
      ok: true;
      paper: PublishedPaper;
      rendered: RenderedPaperMarkdown;
      revisions: PublishedPaperSummary[];
      history_available: boolean;
      translations: PaperTranslation[];
      language?: PaperLanguage;
      history_message?: string;
    }
  | {
      ok: false;
      error: PaperReaderError;
    };

export interface PaperReaderOptions {
  language?: string;
  paper_id: string;
  revision: string;
  api_url?: string;
  fetch?: ApiFetch;
}

export async function readPublishedPaper(
  options: PaperReaderOptions,
): Promise<PaperReaderResult> {
  if (options.language !== undefined && !isPaperLanguage(options.language)) {
    return {
      ok: false,
      error: {
        status: 400,
        title: "Invalid language",
        message: "The requested paper language is not supported.",
      },
    };
  }
  if (paperSlugFromCanonicalId(options.paper_id) === undefined) {
    return invalidPaperIdentifier();
  }
  if (!/^[1-9]\d*$/.test(options.revision)) {
    return invalidRevision();
  }
  const revision = Number(options.revision);
  if (!Number.isSafeInteger(revision) || revision > 4_294_967_295) {
    return invalidRevision();
  }
  const apiUrl = configuredApiUrl(options.api_url);
  if (apiUrl === undefined) {
    return {
      ok: false,
      error: {
        status: 503,
        title: "Archive reader unavailable",
        message: "The public archive API is not configured for this website.",
      },
    };
  }

  try {
    const client = new ProdxivApiClient({
      api_url: apiUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const [original, history, translations] = await Promise.all([
      client.getPaperRevision(options.paper_id, revision),
      client.listPaperRevisions(options.paper_id).catch(() => undefined),
      client
        .listPaperTranslations(options.paper_id, revision)
        .catch((error: unknown) => {
          if (options.language !== undefined) throw error;
          return [] as PaperTranslation[];
        }),
    ]);
    // Rendering the immutable source does not depend on the separate history
    // endpoint. A rolling API upgrade or history failure must not hide it.
    const selected =
      options.language === undefined
        ? undefined
        : translations.find((item) => item.language === options.language);
    if (options.language !== undefined && selected === undefined) {
      return {
        ok: false,
        error: {
          status: 404,
          title: "Language unavailable",
          message:
            "This paper revision is not available in the requested language.",
        },
      };
    }
    const paper =
      selected === undefined ? original : translatedPaper(original, selected);
    const rendered = renderPaperMarkdown(paper.source_markdown);
    const historyAvailable =
      history?.revisions.some((entry) => entry.version === paper.version) ===
      true;
    return {
      ok: true,
      paper,
      rendered,
      revisions: historyAvailable ? (history?.revisions ?? []) : [],
      history_available: historyAvailable,
      translations,
      ...(selected === undefined ? {} : { language: selected.language }),
      ...(historyAvailable
        ? {}
        : { history_message: "Revision history is temporarily unavailable." }),
    };
  } catch (error) {
    return {
      ok: false,
      error: publicError(error),
    };
  }
}

function invalidPaperIdentifier(): PaperReaderResult {
  return {
    ok: false,
    error: {
      status: 400,
      title: "Invalid paper identifier",
      message: "Paper identifiers must use the canonical prodxiv format.",
    },
  };
}

function invalidRevision(): PaperReaderResult {
  return {
    ok: false,
    error: {
      status: 400,
      title: "Invalid paper revision",
      message: "Paper revisions must be positive integers.",
    },
  };
}

function publicError(error: unknown): PaperReaderError {
  if (error instanceof ProdxivApiError) {
    if (error.status === 404) {
      return {
        status: 404,
        title: "Paper revision not found",
        message: "The requested immutable paper revision does not exist.",
      };
    }
    if (error.status === 400) {
      return {
        status: 400,
        title: "Invalid paper identifier",
        message: "The requested paper identifier or revision is invalid.",
      };
    }
    return {
      status: 502,
      title: "Archive API unavailable",
      message: "The paper could not be loaded from the public archive.",
    };
  }
  if (error instanceof PublishedPaperFormatError) {
    return {
      status: 502,
      title: "Published paper is malformed",
      message: "The archived source could not be rendered safely.",
    };
  }
  return {
    status: 500,
    title: "Paper unavailable",
    message: "An unexpected error prevented this paper from being displayed.",
  };
}

export function translatedPaper(
  paper: PublishedPaper,
  translation: PaperTranslation,
): PublishedPaper {
  const metadata = {
    ...paper.metadata,
    title: translation.title,
    summary: translation.summary,
  };
  // JSON is valid YAML; host-owned metadata is retained without model rewriting.
  const source_markdown = `---\n${JSON.stringify(metadata, null, 2)}\n---\n${translation.markdown}`;
  return { ...paper, metadata, source_markdown };
}
