import {
  ProdxivApiClient,
  type ApiFetch,
  type PublishedPaperSummary,
} from "@prodxiv/api-client";

import { configuredApiUrl } from "./api-url.ts";

export interface PaperIndexEntry {
  paper_id: string;
  version: number;
  published_at: string;
  title: string;
  summary: string;
  authors: string[];
  topics: string[];
  href: string;
}

export type PaperIndexResult =
  | {
      ok: true;
      papers: PaperIndexEntry[];
      next_cursor?: string;
    }
  | {
      ok: false;
      message: string;
    };

export interface PaperIndexOptions {
  api_url?: string;
  cursor?: string;
  limit?: number;
  fetch?: ApiFetch;
}

export async function readPublishedPaperIndex(
  options: PaperIndexOptions,
): Promise<PaperIndexResult> {
  const apiUrl = configuredApiUrl(options.api_url);
  if (apiUrl === undefined) {
    return {
      ok: false,
      message: "Published archive records are temporarily unavailable.",
    };
  }

  try {
    const client = new ProdxivApiClient({
      api_url: apiUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const page = await client.listPapers({
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    });
    return {
      ok: true,
      papers: page.papers.map(paperIndexEntry),
      ...(page.next_cursor === undefined
        ? {}
        : { next_cursor: page.next_cursor }),
    };
  } catch {
    return {
      ok: false,
      message: "Published archive records could not be loaded.",
    };
  }
}

function paperIndexEntry(paper: PublishedPaperSummary): PaperIndexEntry {
  return {
    paper_id: paper.paper_id,
    version: paper.version,
    published_at: paper.published_at,
    title: paper.metadata.title,
    summary: paper.metadata.summary,
    authors: paper.metadata.authors.map((author) => author.name),
    topics: paper.metadata.topics,
    href: `/papers/${encodeURIComponent(paper.paper_id)}/versions/${paper.version}`,
  };
}
