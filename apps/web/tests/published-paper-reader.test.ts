import { describe, expect, test } from "bun:test";

import { readPublishedPaper } from "../src/lib/published-paper-reader.ts";

const publishedPaper = {
  schema_version: "1",
  paper_id: "prodxiv:2607.000001",
  version: 1,
  published_at: "2026-07-28",
  metadata: {
    schema_version: "1",
    paper_id: "prodxiv:2607.000001",
    title: "Reader fixture",
    summary: "A complete reader fixture.",
    authors: [{ name: "Test Author" }],
    published_at: "2026-07-28",
    version: 1,
    status: "concept",
    topics: ["developer_tools"],
    license: "CC BY 4.0",
  },
  source_markdown: `---
schema_version: "1"
---
# Summary

Rendered from the API.
`,
};

describe("readPublishedPaper", () => {
  test("rejects invalid versions before calling the API", async () => {
    let fetched = false;
    const result = await readPublishedPaper({
      paper_id: "prodxiv:2607.000001",
      version: "0",
      api_url: "https://api.prodxiv.example",
      fetch: async () => {
        fetched = true;
        return Response.json({});
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ status: 400 }),
      }),
    );
    expect(fetched).toBe(false);
  });

  test("reports missing server configuration", async () => {
    const result = await readPublishedPaper({
      paper_id: "prodxiv:2607.000001",
      version: "1",
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ status: 503 }),
      }),
    );
  });

  test("maps API not-found responses to the public reader", async () => {
    const result = await readPublishedPaper({
      paper_id: "prodxiv:2607.000001",
      version: "2",
      api_url: "https://api.prodxiv.example",
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "paper.not_found",
              message: "paper version does not exist",
            },
          },
          { status: 404 },
        ),
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          status: 404,
          title: "Paper version not found",
        }),
      }),
    );
  });

  test("returns a safely rendered published paper", async () => {
    const result = await readPublishedPaper({
      paper_id: "prodxiv:2607.000001",
      version: "1",
      api_url: "https://api.prodxiv.example",
      fetch: async () => Response.json(publishedPaper),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("valid paper should render");
    }
    expect(result.paper.paper_id).toBe("prodxiv:2607.000001");
    expect(result.rendered.html).toContain('<h1 id="summary">Summary</h1>');
  });
});
