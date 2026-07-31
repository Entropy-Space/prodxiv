import type { APIRoute } from "astro";

import {
  buildGitHubTrendingCsv,
  githubTrendingCsvFilename,
} from "../lib/github-trending-csv.ts";
import { readGitHubTrendingDay } from "../lib/github-trending.ts";

export const prerender = false;

const periods = new Set(["daily", "weekly", "monthly"] as const);

export const GET: APIRoute = async ({ url }) => {
  const date = url.searchParams.get("date")?.trim();
  const periodParameter = url.searchParams.get("period")?.trim() ?? "daily";

  if (date === undefined || !isDate(date)) {
    return textResponse(
      "A valid date in YYYY-MM-DD format is required.\n",
      400,
    );
  }
  if (!isPeriod(periodParameter)) {
    return textResponse("Period must be daily, weekly, or monthly.\n", 400);
  }

  const result = await readGitHubTrendingDay({
    api_url: import.meta.env.PRODXIV_API_URL,
    date,
    period: periodParameter,
  });
  if (!result.ok) {
    return textResponse(`${result.message}\n`, 503);
  }
  if (result.snapshots.length === 0) {
    return textResponse("No snapshots were found for the selected day.\n", 404);
  }

  return new Response(buildGitHubTrendingCsv(result.snapshots), {
    headers: {
      "Cache-Control":
        "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
      "Content-Disposition": `attachment; filename="${githubTrendingCsvFilename(date, periodParameter)}"`,
      "Content-Type": "text/csv; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
};

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value)
  );
}

function isPeriod(value: string): value is "daily" | "weekly" | "monthly" {
  return periods.has(value as "daily" | "weekly" | "monthly");
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
