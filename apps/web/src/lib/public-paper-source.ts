import {
  ProdxivApiClient,
  ProdxivApiError,
  type ApiFetch,
  isPaperLanguage,
} from "@prodxiv/api-client";
import {
  canonicalPaperIdFromSlug,
  paperSlugFromCanonicalId,
  paperVersionFromSlug,
} from "@prodxiv/api-client/public-paper-url";
import { configuredApiUrl } from "./api-url.ts";

import { translatedPaper } from "./published-paper-reader.ts";

export interface PublishedSourceOptions {
  language?: string;
  paper_slug: string;
  version_slug: string;
  api_url?: string;
  fetch?: ApiFetch;
}

export async function publishedSourceResponse(
  options: PublishedSourceOptions,
): Promise<Response> {
  if (options.language !== undefined && !isPaperLanguage(options.language))
    return sourceError(400, "Invalid language.");
  const paperId = canonicalPaperIdFromSlug(options.paper_slug);
  const revision = paperVersionFromSlug(options.version_slug);
  if (paperId === undefined || revision === undefined) {
    return sourceError(400, "Invalid paper identifier or revision.");
  }
  const apiUrl = configuredApiUrl(options.api_url);
  if (apiUrl === undefined) {
    return sourceError(503, "The public archive API is not configured.");
  }

  try {
    const client = new ProdxivApiClient({
      api_url: apiUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    let paper = await client.getPaperRevision(paperId, revision);
    if (options.language !== undefined) {
      const translations = await client.listPaperTranslations(
        paperId,
        revision,
      );
      const selected = translations.find(
        (item) => item.language === options.language,
      );
      if (selected === undefined)
        return sourceError(404, "Language unavailable.");
      paper = translatedPaper(paper, selected);
    }
    const slug = paperSlugFromCanonicalId(paperId);
    return new Response(paper.source_markdown, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${slug}-v${revision}${options.language === undefined ? "" : `-${options.language}`}.md"`,
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ProdxivApiError && error.status === 404) {
      return sourceError(404, "Paper revision not found.");
    }
    return sourceError(502, "The archived Markdown could not be loaded.");
  }
}

function sourceError(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
