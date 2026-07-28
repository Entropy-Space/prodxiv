import { describe, expect, test } from "bun:test";

import {
  ProdxivApiClient,
  ProdxivApiError,
  type PublishedPaper,
} from "../src/client.ts";

const publishedPaper = {
  schema_version: "1",
  paper_id: "prodxiv:2607.000001",
  version: 1,
  published_at: "2026-07-28",
  metadata: {
    schema_version: "1",
    paper_id: "prodxiv:2607.000001",
    title: "Test paper",
    summary: "A complete API client fixture.",
    authors: [{ name: "Test Author" }],
    published_at: "2026-07-28",
    version: 1,
    status: "concept",
    topics: ["developer_tools"],
    license: "CC BY 4.0",
  },
  source_markdown: '---\nschema_version: "1"\n---\n# Summary\n',
} satisfies PublishedPaper;

describe("ProdxivApiClient", () => {
  test("lists published papers with encoded pagination parameters", async () => {
    let requestUrl = "";
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example/",
      fetch: async (input) => {
        requestUrl = input.toString();
        const { source_markdown: _, ...summary } = publishedPaper;
        return Response.json({
          papers: [summary],
          next_cursor: "next/page",
        });
      },
    });

    const page = await client.listPapers({
      limit: 10,
      cursor: "current/page",
    });

    expect(page.papers[0]?.paper_id).toBe("prodxiv:2607.000001");
    expect(page.next_cursor).toBe("next/page");
    expect(requestUrl).toBe(
      "https://api.prodxiv.example/v1/papers?limit=10&cursor=current%2Fpage",
    );
  });

  test("reads an exact public paper version without a token", async () => {
    let requestUrl = "";
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example/",
      fetch: async (input) => {
        requestUrl = input.toString();
        return Response.json(publishedPaper);
      },
    });

    expect(await client.getPaperVersion("prodxiv:2607.000001", 1)).toEqual(
      publishedPaper,
    );
    expect(requestUrl).toBe(
      "https://api.prodxiv.example/v1/papers/prodxiv%3A2607.000001/versions/1",
    );
  });

  test("preserves structured API errors", async () => {
    const client = new ProdxivApiClient({
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

    await expect(
      client.getPaperVersion("prodxiv:2607.000001", 2),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "ProdxivApiError",
        status: 404,
        code: "paper.not_found",
      } satisfies Partial<ProdxivApiError>),
    );
  });

  test("rejects inconsistent publication metadata", async () => {
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example",
      fetch: async () =>
        Response.json({
          ...publishedPaper,
          metadata: {
            ...publishedPaper.metadata,
            version: 2,
          },
        }),
    });

    await expect(
      client.getPaperVersion("prodxiv:2607.000001", 1),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "network.invalid_response",
      } satisfies Partial<ProdxivApiError>),
    );
  });

  test("rejects invalid publication dates before they reach a renderer", async () => {
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example",
      fetch: async () =>
        Response.json({
          ...publishedPaper,
          published_at: "2026-02-31",
          metadata: {
            ...publishedPaper.metadata,
            published_at: "2026-02-31",
          },
        }),
    });

    await expect(
      client.getPaperVersion("prodxiv:2607.000001", 1),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "network.invalid_response",
      } satisfies Partial<ProdxivApiError>),
    );
  });
});
