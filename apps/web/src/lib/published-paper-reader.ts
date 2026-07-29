import {
  ProdxivApiClient,
  ProdxivApiError,
  type ApiFetch,
  type PublishedPaper,
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
    }
  | {
      ok: false;
      error: PaperReaderError;
    };

export interface PaperReaderOptions {
  paper_id: string;
  revision: string;
  api_url?: string;
  fetch?: ApiFetch;
}

export async function readPublishedPaper(
  options: PaperReaderOptions,
): Promise<PaperReaderResult> {
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
    const paper = await client.getPaperRevision(options.paper_id, revision);
    return {
      ok: true,
      paper,
      rendered: renderPaperMarkdown(paper.source_markdown),
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
