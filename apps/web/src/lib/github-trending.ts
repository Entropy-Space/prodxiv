import {
  ProdxivApiClient,
  type ApiFetch,
  type GitHubTrendingSnapshot,
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

export type GitHubTrendingDayResult =
  | {
      ok: true;
      snapshots: GitHubTrendingSnapshot[];
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
      language: options.language ?? "any",
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

export async function readGitHubTrendingDay(
  options: Omit<ReadGitHubTrendingOptions, "language"> & { date: string },
): Promise<GitHubTrendingDayResult> {
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
      date: options.date,
      ...(options.period === undefined ? {} : { period: options.period }),
      language: "all",
      ...(options.spoken_language === undefined
        ? {}
        : { spoken_language: options.spoken_language }),
    });
    return { ok: true, snapshots: view.snapshots };
  } catch {
    return {
      ok: false,
      message: "GitHub Trending observations could not be loaded.",
    };
  }
}
