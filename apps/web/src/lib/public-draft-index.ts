import {
  ProdxivApiClient,
  ProdxivApiError,
  type ApiFetch,
  type PaperMetadata,
  type PublicPaperDraftSummary,
} from "@prodxiv/api-client";

import { configuredApiUrl } from "./api-url.ts";

export interface DraftIndexEntry extends PublicPaperDraftSummary {
  title: string;
  summary: string;
  authors: string[];
  writers?: PaperMetadata["writers"];
  topics: string[];
  repository_url?: string;
  href: string;
  metadata_available: boolean;
}

export type DraftIndexResult =
  | {
      ok: true;
      drafts: DraftIndexEntry[];
      next_cursor?: string;
    }
  | {
      ok: false;
      status: number;
      message: string;
    };

export interface DraftIndexOptions {
  api_url?: string;
  limit?: number;
  cursor?: string;
  fetch?: ApiFetch;
}

export async function readPublicDraftIndex(
  options: DraftIndexOptions,
): Promise<DraftIndexResult> {
  const apiUrl = configuredApiUrl(options.api_url);
  if (apiUrl === undefined) {
    return {
      ok: false,
      status: 503,
      message: "The public draft reader is not configured for this website.",
    };
  }
  try {
    const client = new ProdxivApiClient({
      api_url: apiUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const page = await client.listPublicDrafts({
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    });
    return {
      ok: true,
      drafts: page.drafts.map(draftIndexEntry),
      ...(page.next_cursor === undefined
        ? {}
        : { next_cursor: page.next_cursor }),
    };
  } catch (error) {
    if (error instanceof ProdxivApiError) {
      if (error.code === "draft.public_reads_disabled") {
        return {
          ok: false,
          status: 503,
          message:
            "Public draft reading has not been enabled for this archive.",
        };
      }
      if (error.status === 400 || error.code.startsWith("request.invalid_")) {
        return {
          ok: false,
          status: 400,
          message:
            "The requested draft page is invalid. Return to the first page and try again.",
        };
      }
    }
    return {
      ok: false,
      status: 502,
      message: "Pending drafts could not be loaded. Please try again later.",
    };
  }
}

function draftIndexEntry(draft: PublicPaperDraftSummary): DraftIndexEntry {
  const metadata = draft.metadata;
  return {
    ...draft,
    title: metadata?.title ?? "Untitled draft",
    summary:
      metadata?.summary ??
      "This draft does not yet have readable paper metadata.",
    authors: metadata?.authors.map((author) => author.name) ?? [],
    ...(metadata?.writers === undefined ? {} : { writers: metadata.writers }),
    topics: metadata?.topics ?? [],
    ...(metadata?.repository_url == null
      ? {}
      : { repository_url: metadata.repository_url }),
    href: `/drafts/${draft.paper_uuid}`,
    metadata_available: metadata != null,
  };
}
