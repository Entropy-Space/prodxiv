import { describe, expect, test } from "bun:test";
import { publishedSourceResponse } from "../src/lib/public-paper-source.ts";

const source =
  '---\r\nschema_version: "1"\r\n---\r\n# Summary\r\n\r\nExact archived source.\r\n';
const paper = {
  schema_version: "1",
  paper_id: "prodxiv:2607.000001",
  product_id: "prodxiv-product:2607.000001",
  version: 2,
  published_at: "2026-07-28",
  metadata: {
    schema_version: "1",
    paper_id: "prodxiv:2607.000001",
    title: "Source fixture",
    summary: "A source fixture.",
    authors: [{ name: "Test Author" }],
    version: 2,
    published_at: "2026-07-28",
    status: "concept",
    topics: ["developer_tools"],
    license: "CC BY 4.0",
  },
  source_markdown: source,
};
const options = {
  paper_slug: "2607.000001",
  version_slug: "v2",
  api_url: "https://api.prodxiv.example",
};

describe("publishedSourceResponse", () => {
  test("downloads the exact selected revision without rendering or credentials", async () => {
    const response = await publishedSourceResponse({
      ...options,
      fetch: async (url, init) => {
        expect(String(url)).toEndWith(
          "/v1/papers/prodxiv%3A2607.000001/revisions/2",
        );
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return Response.json(paper);
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(source);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="2607.000001-v2.md"',
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  test("rejects unsafe route parameters without a request", async () => {
    let fetched = false;
    for (const invalid of [
      { paper_slug: "../private", version_slug: "v2" },
      { paper_slug: "2607.000001", version_slug: "v0" },
    ]) {
      const response = await publishedSourceResponse({
        ...options,
        ...invalid,
        fetch: async () => {
          fetched = true;
          return Response.json(paper);
        },
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(fetched).toBe(false);
  });

  test("does not serve source for a different revision returned by the API", async () => {
    const response = await publishedSourceResponse({
      ...options,
      fetch: async () =>
        Response.json({
          ...paper,
          version: 1,
          metadata: { ...paper.metadata, version: 1 },
        }),
    });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(source);
  });

  test("keeps errors distinct and does not expose upstream details", async () => {
    const missing = await publishedSourceResponse({
      ...options,
      fetch: async () =>
        Response.json(
          { error: { code: "paper.not_found", message: "internal detail" } },
          { status: 404 },
        ),
    });
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain("internal detail");
    const unavailable = await publishedSourceResponse({
      ...options,
      fetch: async () => {
        throw new Error("private infrastructure failure");
      },
    });
    expect(unavailable.status).toBe(502);
    expect(await unavailable.text()).not.toContain("private infrastructure");
  });
});
