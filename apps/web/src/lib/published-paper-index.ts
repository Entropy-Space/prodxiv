import {
  ProdxivApiClient,
  type ApiFetch,
  type PublishedPaperSummary,
  type PaperMetadata,
} from "@prodxiv/api-client";
import { publicPaperPath } from "@prodxiv/api-client/public-paper-url";

import { configuredApiUrl } from "./api-url.ts";

export interface PaperIndexEntry {
  paper_id: string;
  version: number;
  published_at: string;
  title: string;
  summary: string;
  authors: string[];
  writers?: PaperMetadata["writers"];
  product_name?: string;
  repository_url?: string;
  topics: string[];
  href: string;
}

export type PaperIndexResult =
  | {
      ok: true;
      papers: PaperIndexEntry[];
      topics: string[];
      topics_available: boolean;
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
  q?: string;
  topic?: string;
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
    const [page, topicList] = await Promise.all([
      client.listPapers({
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        ...(options.q === undefined ? {} : { q: options.q }),
        ...(options.topic === undefined ? {} : { topic: options.topic }),
      }),
      client.listPaperTopics().catch(() => undefined),
    ]);
    return {
      ok: true,
      papers: page.papers.map(paperIndexEntry),
      topics: topicList?.topics ?? [],
      topics_available: topicList !== undefined,
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
    ...(paper.metadata.writers === undefined
      ? {}
      : { writers: paper.metadata.writers }),
    ...(paper.metadata.product_name == null
      ? {}
      : { product_name: paper.metadata.product_name }),
    ...(paper.metadata.repository_url == null
      ? {}
      : { repository_url: paper.metadata.repository_url }),
    topics: paper.metadata.topics,
    href: publicPaperPath(paper.paper_id, paper.version),
  };
}
