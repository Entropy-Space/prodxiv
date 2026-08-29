import type { PublishedPaper } from "@prodxiv/api-client";

type CitationPaper = Pick<
  PublishedPaper,
  "paper_id" | "version" | "published_at"
> & {
  metadata: Pick<PublishedPaper["metadata"], "title" | "authors">;
};

export function publicationCitation(
  paper: CitationPaper,
  canonical_url: string,
): string {
  const authors = paper.metadata.authors
    .map((author) => author.name)
    .join(", ");
  const title = paper.metadata.title.trim();
  const punctuatedTitle = /[.!?]$/.test(title) ? title : `${title}.`;
  const punctuatedAuthors = /[.!?]$/.test(authors) ? authors : `${authors}.`;
  return `${punctuatedAuthors} “${punctuatedTitle}” prodxiv, ${paper.published_at}, ${paper.paper_id}v${paper.version}. ${canonical_url}`;
}

export function formatPaperDate(value: string, include_time = false): string {
  const date = new Date(value.includes("T") ? value : `${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "long",
    ...(include_time ? { timeStyle: "short" as const } : {}),
    timeZone: "UTC",
  }).format(date);
}

export function publicResourceUrl(
  value: string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
