import { describe, expect, test } from "bun:test";

import { readPublishedPaperIndex } from "../src/lib/published-paper-index.ts";

const summary = {
  schema_version: "1",
  paper_id: "prodxiv:2607.000001",
  version: 1,
  published_at: "2026-07-28",
  metadata: {
    schema_version: "1",
    paper_id: "prodxiv:2607.000001",
    title: "Index fixture",
    summary: "A complete index fixture.",
    authors: [{ name: "Test Author" }],
    published_at: "2026-07-28",
    version: 1,
    status: "concept",
    topics: ["developer_tools"],
    license: "CC BY 4.0",
  },
};

describe("readPublishedPaperIndex", () => {
  test("maps API summaries to exact reader links", async () => {
    let requestUrl = "";
    const result = await readPublishedPaperIndex({
      api_url: "https://api.prodxiv.example",
      limit: 20,
      fetch: async (input) => {
        requestUrl = input.toString();
        return Response.json({
          papers: [summary],
          next_cursor: "next-page",
        });
      },
    });

    expect(result).toEqual({
      ok: true,
      papers: [
        {
          paper_id: "prodxiv:2607.000001",
          version: 1,
          published_at: "2026-07-28",
          title: "Index fixture",
          summary: "A complete index fixture.",
          authors: ["Test Author"],
          topics: ["developer_tools"],
          href: "/papers/prodxiv%3A2607.000001/versions/1",
        },
      ],
      next_cursor: "next-page",
    });
    expect(requestUrl).toBe("https://api.prodxiv.example/v1/papers?limit=20");
  });

  test("returns a safe fallback when the API is unavailable", async () => {
    expect(await readPublishedPaperIndex({})).toEqual({
      ok: false,
      message: "Published archive records are temporarily unavailable.",
    });

    expect(
      await readPublishedPaperIndex({
        api_url: "https://api.prodxiv.example",
        fetch: async () => {
          throw new Error("secret internal network detail");
        },
      }),
    ).toEqual({
      ok: false,
      message: "Published archive records could not be loaded.",
    });
  });
});
