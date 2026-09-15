import type { APIRoute } from "astro";
import { publishedSourceResponse } from "../../../../lib/public-paper-source.ts";

export const prerender = false;

export const GET: APIRoute = ({ params, url }) =>
  publishedSourceResponse({
    paper_slug: params.paper_slug ?? "",
    version_slug: params.version_slug ?? "",
    language: url.searchParams.get("lang") ?? undefined,
    api_url: import.meta.env.PRODXIV_API_URL,
  });
