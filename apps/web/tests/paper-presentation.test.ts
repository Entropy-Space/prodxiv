import { describe, expect, test } from "bun:test";
import {
  formatPaperDate,
  publicationCitation,
  publicResourceUrl,
} from "../src/components/paper-presentation.ts";

describe("paper reader presentation", () => {
  test("binds a citation to the selected revision, date, authors, and canonical page", () => {
    const citation = publicationCitation(
      {
        paper_id: "prodxiv:2608.000001",
        version: 2,
        published_at: "2026-08-28",
        metadata: {
          title: "Product knowledge with a history",
          authors: [
            { name: "Example author" },
            { name: "Example organization" },
          ],
        },
      },
      "https://archive.example/papers/2608.000001/v2",
    );
    expect(citation).toBe(
      "Example author, Example organization. “Product knowledge with a history.” prodxiv, 2026-08-28, prodxiv:2608.000001v2. https://archive.example/papers/2608.000001/v2",
    );
    expect(citation).not.toContain("Paperbot");
  });

  test("does not duplicate punctuation already present in revision metadata", () => {
    expect(
      publicationCitation(
        {
          paper_id: "prodxiv:2608.000001",
          version: 1,
          published_at: "2026-08-27",
          metadata: {
            title: "A complete record.",
            authors: [{ name: "Example, Inc." }],
          },
        },
        "https://archive.example/papers/2608.000001/v1",
      ),
    ).toContain("Example, Inc. “A complete record.” prodxiv");
  });

  test("formats publication dates and draft timestamps in UTC", () => {
    expect(formatPaperDate("2026-08-28")).toBe("August 28, 2026");
    expect(formatPaperDate("2026-08-28T01:30:00+08:00", true)).toBe(
      "August 27, 2026 at 5:30 PM",
    );
    expect(formatPaperDate("not-a-date")).toBe("Date unavailable");
  });

  test("keeps resource links public and rejects active schemes and credentials", () => {
    expect(publicResourceUrl("https://github.com/owner/repo")).toBe(
      "https://github.com/owner/repo",
    );
    expect(publicResourceUrl("http://example.com/docs")).toBe(
      "http://example.com/docs",
    );
    for (const value of [
      null,
      undefined,
      "",
      "javascript:alert(1)",
      "data:text/html,hello",
      "file:///private/draft.md",
      "/relative-path",
      "https://user:secret@example.com/private",
    ]) {
      expect(publicResourceUrl(value)).toBeUndefined();
    }
  });
});
