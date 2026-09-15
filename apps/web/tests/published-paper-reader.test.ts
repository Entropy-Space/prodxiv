import { describe, expect, test } from "bun:test";

import { readPublishedPaper } from "../src/lib/published-paper-reader.ts";

const publishedPaper = {
  schema_version: "1",
  paper_id: "prodxiv:2607.000001",
  product_id: "prodxiv-product:2607.000001",
  version: 1,
  published_at: "2026-07-28",
  metadata: {
    schema_version: "1",
    paper_id: "prodxiv:2607.000001",
    title: "Reader fixture",
    product_name: "Reader product",
    scope: { kind: "product" },
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
  test("rejects invalid identifiers before calling the API", async () => {
    let fetched = false;
    const result = await readPublishedPaper({
      paper_id: "2607.000001",
      revision: "1",
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

  test("rejects invalid revisions before calling the API", async () => {
    let fetched = false;
    const result = await readPublishedPaper({
      paper_id: "prodxiv:2607.000001",
      revision: "0",
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
      revision: "1",
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
      revision: "2",
      api_url: "https://api.prodxiv.example",
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "paper.not_found",
              message: "paper revision does not exist",
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
          title: "Paper revision not found",
        }),
      }),
    );
  });

  test("returns a safely rendered published paper", async () => {
    const result = await readPublishedPaper({
      paper_id: "prodxiv:2607.000001",
      revision: "1",
      api_url: "https://api.prodxiv.example",
      fetch: async () => Response.json(publishedPaper),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("valid paper should render");
    }
    expect(result.paper.paper_id).toBe("prodxiv:2607.000001");
    expect(result.rendered.html).toContain('<h1 id="summary">Summary</h1>');
    expect(result.history_available).toBe(false);
    expect(result.revisions).toEqual([]);
  });

  test("returns real history without inferring missing revision numbers", async () => {
    const newer = {
      ...publishedPaper,
      version: 3,
      metadata: { ...publishedPaper.metadata, version: 3 },
    };
    const result = await readPublishedPaper({
      paper_id: publishedPaper.paper_id,
      revision: "1",
      api_url: "https://api.prodxiv.example",
      fetch: async (input) =>
        input.toString().endsWith("/revisions")
          ? Response.json({ revisions: [publishedPaper, newer] })
          : Response.json(publishedPaper),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected readable paper");
    expect(result.history_available).toBe(true);
    expect(result.revisions.map((entry) => entry.version)).toEqual([3, 1]);
    expect(result.paper.version).toBe(1);
    expect(result.rendered.html).toContain("Rendered from the API.");
  });

  test("falls back when history omits the selected revision", async () => {
    const newer = {
      ...publishedPaper,
      version: 2,
      metadata: { ...publishedPaper.metadata, version: 2 },
    };
    const result = await readPublishedPaper({
      paper_id: publishedPaper.paper_id,
      revision: "1",
      api_url: "https://api.prodxiv.example",
      fetch: async (input) =>
        input.toString().endsWith("/revisions")
          ? Response.json({ revisions: [newer] })
          : Response.json(publishedPaper),
    });
    expect(result).toMatchObject({
      ok: true,
      paper: { version: 1 },
      history_available: false,
      revisions: [],
    });
  });

  test("does not show a different revision under the requested URL", async () => {
    const result = await readPublishedPaper({
      paper_id: publishedPaper.paper_id,
      revision: "2",
      api_url: "https://api.prodxiv.example",
      fetch: async () => Response.json(publishedPaper),
    });
    expect(result).toMatchObject({ ok: false, error: { status: 502 } });
  });
});

test("renders Japanese with no English variant and refuses missing languages", async () => {
  const translations = [
    {
      language: "ja",
      title: "概要",
      summary: "説明",
      markdown: "# 概要\n\n日本語。",
      source_sha256: "a".repeat(64),
      model: "test",
    },
  ];
  const fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    return Response.json(
      url.endsWith("/translations")
        ? translations
        : url.endsWith("/revisions")
          ? { revisions: [] }
          : publishedPaper,
    );
  };
  const options = {
    paper_id: publishedPaper.paper_id,
    revision: "1",
    api_url: "https://api.example",
    fetch,
  };
  const japanese = await readPublishedPaper({ ...options, language: "ja" });
  expect(japanese.ok).toBe(true);
  if (japanese.ok) {
    expect(japanese.paper.metadata.title).toBe("概要");
    expect(japanese.rendered.html).toContain("日本語。");
    expect(japanese.translations.map((item) => item.language)).toEqual(["ja"]);
  }
  const english = await readPublishedPaper({ ...options, language: "en" });
  expect(english).toMatchObject({ ok: false, error: { status: 404 } });
});
