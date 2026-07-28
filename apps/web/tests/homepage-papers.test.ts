import { describe, expect, test } from "bun:test";
import { selectReferencePapers } from "../src/lib/homepage-papers.ts";
import type { PaperIndexEntry } from "../src/lib/published-paper-index.ts";

const publishedPaper: PaperIndexEntry = {
  paper_id: "prodxiv:2607.000001",
  version: 1,
  published_at: "2026-07-28",
  title: "Published paper",
  summary: "A paper stored in the publishing database.",
  authors: ["Archive author"],
  topics: ["developer_tools"],
  href: "/papers/2607.000001/v1",
};

const referencePaper: PaperIndexEntry = {
  paper_id: "prodxiv:2607.000002",
  version: 1,
  published_at: "2026-07-27",
  title: "Reference paper",
  summary: "A checked-in example of the product-paper format.",
  authors: ["Example author"],
  topics: ["product_design"],
  href: "/papers/reference-paper",
};

describe("selectReferencePapers", () => {
  test("shows checked-in examples separately on the first page", () => {
    expect(
      selectReferencePapers({
        is_first_page: true,
        published_papers: [publishedPaper],
        reference_papers: [referencePaper],
      }),
    ).toEqual([referencePaper]);
  });

  test("does not repeat an exact version that was published", () => {
    expect(
      selectReferencePapers({
        is_first_page: true,
        published_papers: [publishedPaper],
        reference_papers: [publishedPaper],
      }),
    ).toEqual([]);
  });

  test("omits examples from paginated archive pages", () => {
    expect(
      selectReferencePapers({
        is_first_page: false,
        published_papers: [],
        reference_papers: [referencePaper],
      }),
    ).toEqual([]);
  });
});
