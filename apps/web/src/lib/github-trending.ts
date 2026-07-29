import {
  ProdxivApiClient,
  type ApiFetch,
  type GitHubTrendingView,
} from "@prodxiv/api-client";

import { configuredApiUrl } from "./api-url.ts";

export type GitHubTrendingResult =
  | {
      ok: true;
      view: GitHubTrendingView;
    }
  | {
      ok: false;
      message: string;
    };

interface ReadGitHubTrendingOptions {
  api_url?: string;
  date?: string;
  period?: "daily" | "weekly" | "monthly";
  language?: string;
  spoken_language?: string;
  fetch?: ApiFetch;
}

export async function readGitHubTrending(
  options: ReadGitHubTrendingOptions,
): Promise<GitHubTrendingResult> {
  const apiUrl = configuredApiUrl(options.api_url);
  if (apiUrl === undefined) {
    return {
      ok: false,
      message: "GitHub Trending observations are temporarily unavailable.",
    };
  }

  try {
    const client = new ProdxivApiClient({
      api_url: apiUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const view = await client.getGitHubTrending({
      ...(options.date === undefined ? {} : { date: options.date }),
      ...(options.period === undefined ? {} : { period: options.period }),
      ...(options.language === undefined ? {} : { language: options.language }),
      ...(options.spoken_language === undefined
        ? {}
        : { spoken_language: options.spoken_language }),
    });
    return {
      ok: true,
      view,
    };
  } catch {
    return {
      ok: false,
      message: "GitHub Trending observations could not be loaded.",
    };
  }
}
