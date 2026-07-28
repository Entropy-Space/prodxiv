import {
  ProdxivApiClient,
  ProdxivApiError,
  type ApiFetch,
  type PublishedPaper,
} from "@prodxiv/api-client";

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
  version: string;
  api_url?: string;
  fetch?: ApiFetch;
}

export async function readPublishedPaper(
  options: PaperReaderOptions,
): Promise<PaperReaderResult> {
  if (!/^[1-9]\d*$/.test(options.version)) {
    return invalidVersion();
  }
  const version = Number(options.version);
  if (!Number.isSafeInteger(version) || version > 4_294_967_295) {
    return invalidVersion();
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
    const paper = await client.getPaperVersion(options.paper_id, version);
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

function invalidVersion(): PaperReaderResult {
  return {
    ok: false,
    error: {
      status: 400,
      title: "Invalid paper version",
      message: "Paper versions must be positive integers.",
    },
  };
}

function configuredApiUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  try {
    const url = new URL(value);
    const isLocal =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1";
    if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
      return undefined;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function publicError(error: unknown): PaperReaderError {
  if (error instanceof ProdxivApiError) {
    if (error.status === 404) {
      return {
        status: 404,
        title: "Paper version not found",
        message: "The requested immutable paper version does not exist.",
      };
    }
    if (error.status === 400) {
      return {
        status: 400,
        title: "Invalid paper identifier",
        message: "The requested paper identifier or version is invalid.",
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
