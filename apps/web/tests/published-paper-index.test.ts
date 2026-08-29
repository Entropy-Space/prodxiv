import { describe, expect, test } from "bun:test";

import { readPublishedPaperIndex } from "../src/lib/published-paper-index.ts";

const summary = {
  schema_version: "1",
  paper_id: "prodxiv:2607.000001",
  product_id: "prodxiv-product:2607.000001",
  version: 1,
  published_at: "2026-07-28",
  metadata: {
    schema_version: "1",
    paper_id: "prodxiv:2607.000001",
    title: "Index fixture",
    product_name: "Index product",
    scope: { kind: "product" },
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
    const requestUrls: string[] = [];
    const result = await readPublishedPaperIndex({
      api_url: "https://api.prodxiv.example",
      limit: 20,
      fetch: async (input) => {
        requestUrls.push(input.toString());
        if (input.toString().endsWith("/topics")) {
          return Response.json({ topics: ["developer_tools"] });
        }
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
          product_name: "Index product",
          topics: ["developer_tools"],
          href: "/papers/2607.000001/v1",
        },
      ],
      next_cursor: "next-page",
      topics: ["developer_tools"],
      topics_available: true,
    });
    expect(requestUrls).toContain(
      "https://api.prodxiv.example/v1/papers?limit=20",
    );
  });

  test("passes archive-wide filters and preserves papers when topics fail", async () => {
    const requests: string[] = [];
    const result = await readPublishedPaperIndex({
      api_url: "https://api.prodxiv.example",
      q: "Index fixture",
      topic: "developer_tools",
      cursor: "next/page",
      fetch: async (input) => {
        requests.push(input.toString());
        if (input.toString().endsWith("/topics"))
          throw new Error("internal failure");
        return Response.json({ papers: [summary] });
      },
    });
    expect(result).toMatchObject({
      ok: true,
      papers: [{ title: "Index fixture" }],
      topics: [],
      topics_available: false,
    });
    expect(requests).toContain(
      "https://api.prodxiv.example/v1/papers?cursor=next%2Fpage&q=Index+fixture&topic=developer_tools",
    );
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
