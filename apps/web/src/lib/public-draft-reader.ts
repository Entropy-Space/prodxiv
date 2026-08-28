import {
  ProdxivApiClient,
  ProdxivApiError,
  type ApiFetch,
  type PublicPaperDraft,
} from "@prodxiv/api-client";
import { publicPaperPath } from "@prodxiv/api-client/public-paper-url";

import { configuredApiUrl } from "./api-url.ts";
import {
  renderDraftMarkdown,
  type RenderedPaperMarkdown,
} from "./render-paper-markdown.ts";
import type { PaperReaderError } from "./published-paper-reader.ts";

export type PublicDraftReaderResult =
  | {
      ok: true;
      kind: "draft";
      draft: PublicPaperDraft;
      rendered: RenderedPaperMarkdown;
      incomplete: boolean;
    }
  | {
      ok: true;
      kind: "published";
      paper_id: string;
      version: number;
      href: string;
    }
  | {
      ok: false;
      error: PaperReaderError;
    };

export interface PublicDraftReaderOptions {
  paper_uuid: string;
  api_url?: string;
  fetch?: ApiFetch;
}

export async function readPublicDraft(
  options: PublicDraftReaderOptions,
): Promise<PublicDraftReaderResult> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      options.paper_uuid,
    )
  ) {
    return {
      ok: false,
      error: {
        status: 400,
        title: "Invalid draft identifier",
        message: "Draft links must contain a canonical paper UUID.",
      },
    };
  }
  const apiUrl = configuredApiUrl(options.api_url);
  if (apiUrl === undefined) {
    return {
      ok: false,
      error: {
        status: 503,
        title: "Draft reader unavailable",
        message: "The public draft API is not configured for this website.",
      },
    };
  }
  try {
    const client = new ProdxivApiClient({
      api_url: apiUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const result = await client.getPublicDraft(options.paper_uuid);
    if (result.kind === "published") {
      return {
        ok: true,
        ...result,
        href: publicPaperPath(result.paper_id, result.version),
      };
    }
    const rendered = renderDraftMarkdown(result.draft.source_markdown);
    return {
      ok: true,
      kind: "draft",
      draft: result.draft,
      rendered,
      incomplete:
        result.draft.metadata == null ||
        !rendered.front_matter_complete ||
        rendered.html.trim().length === 0,
    };
  } catch (error) {
    return { ok: false, error: publicDraftError(error) };
  }
}

function publicDraftError(error: unknown): PaperReaderError {
  if (error instanceof ProdxivApiError) {
    if (error.code === "draft.public_reads_disabled") {
      return {
        status: 503,
        title: "Public drafts unavailable",
        message: "Public draft reading has not been enabled for this archive.",
      };
    }
    if (error.status === 404) {
      return {
        status: 404,
        title: "Draft not available",
        message:
          "This draft does not exist or is not available for public reading.",
      };
    }
    if (error.status === 400 || error.code === "draft.invalid_uuid") {
      return {
        status: 400,
        title: "Invalid draft identifier",
        message: "The requested draft identifier is invalid.",
      };
    }
  }
  return {
    status: 502,
    title: "Draft unavailable",
    message: "The draft could not be loaded safely. Please try again later.",
  };
}
