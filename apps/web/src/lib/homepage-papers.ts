import type { PaperIndexEntry } from "./published-paper-index.ts";

export function selectReferencePapers({
  is_first_page,
  published_papers,
  reference_papers,
}: {
  is_first_page: boolean;
  published_papers: PaperIndexEntry[];
  reference_papers: PaperIndexEntry[];
}): PaperIndexEntry[] {
  if (!is_first_page) {
    return [];
  }

  const publishedVersions = new Set(
    published_papers.map((paper) => `${paper.paper_id}:${paper.version}`),
  );

  return reference_papers
    .filter(
      (paper) => !publishedVersions.has(`${paper.paper_id}:${paper.version}`),
    )
    .sort((left, right) => right.published_at.localeCompare(left.published_at));
}
