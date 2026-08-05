import { describe, expect, test } from "bun:test";

import {
  ProdxivApiClient,
  ProdxivApiError,
  type PublishedPaper,
} from "../src/client.ts";

const publishedPaper = {
  schema_version: "1",
  paper_id: "prodxiv:2607.000001",
  product_id: "prodxiv-product:2607.000001",
  version: 1,
  published_at: "2026-07-28",
  metadata: {
    schema_version: "1",
    paper_id: "prodxiv:2607.000001",
    title: "Test paper",
    product_name: "Test product",
    scope: { kind: "product" },
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

const publishedPaperV2 = {
  schema_version: "2",
  paper_id: "prodxiv:2608.000001",
  product_id: "prodxiv-product:2608.000001",
  version: 1,
  published_at: "2026-08-05",
  metadata: {
    schema_version: "2",
    paper_id: "prodxiv:2608.000001",
    title: "Observed product paper",
    product_name: "Observed product",
    scope: { kind: "product" },
    summary: "A schema-version-2 API client fixture.",
    authors: [
      {
        id: "github:example",
        kind: "organization",
        name: "example",
        url: "https://github.com/example",
      },
    ],
    writers: [
      {
        kind: "agent",
        name: "paperbot",
        model: "deepseek-v4-flash",
      },
    ],
    published_at: "2026-08-05",
    version: 1,
    status: {
      value: "launched",
      determination: "inferred",
      confidence: "high",
      observed_at: "2026-08-05T00:00:00Z",
      evidence: [
        {
          kind: "github_release",
          url: "https://github.com/example/product/releases/tag/v1.0.0",
          tag: "v1.0.0",
        },
      ],
    },
    topics: ["developer_tools"],
    license: "CC BY 4.0",
  },
  source_markdown: '---\nschema_version: "2"\n---\n# Summary\n',
} satisfies PublishedPaper;

describe("ProdxivApiClient", () => {
  test("reads a GitHub Trending snapshot with an exact scope", async () => {
    let requestUrl = "";
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example",
      fetch: async (input) => {
        requestUrl = input.toString();
        return Response.json({
          requested_language: "typescript",
          previous_date: "2026-07-28",
          next_date: null,
          available_languages: ["rust", "typescript"],
          snapshots: [
            {
              snapshot_date: "2026-07-29",
              captured_at: null,
              period: "daily",
              language: "typescript",
              spoken_language: null,
              source_kind: "third_party_archive",
              source_url: "https://example.com/archive",
              source_revision: "abc123",
              entries: [
                {
                  rank: 1,
                  repository_full_name: "pascalorg/editor",
                  repository_node_id: null,
                  repository_url: "https://github.com/pascalorg/editor",
                  description: "A repository",
                  primary_language: "TypeScript",
                  stars: null,
                  forks: null,
                  stars_in_period: null,
                },
              ],
            },
          ],
        });
      },
    });

    const view = await client.getGitHubTrending({
      date: "2026-07-29",
      period: "daily",
      language: "typescript",
    });

    expect(view.snapshots[0]?.entries[0]?.repository_full_name).toBe(
      "pascalorg/editor",
    );
    expect(view.requested_language).toBe("typescript");
    expect(view.previous_date).toBe("2026-07-28");
    expect(requestUrl).toBe(
      "https://api.prodxiv.example/v1/github/trending?date=2026-07-29&period=daily&language=typescript",
    );
  });

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

  test("reads an exact public paper revision without a token", async () => {
    let requestUrl = "";
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example/",
      fetch: async (input) => {
        requestUrl = input.toString();
        return Response.json(publishedPaper);
      },
    });

    expect(await client.getPaperRevision("prodxiv:2607.000001", 1)).toEqual(
      publishedPaper,
    );
    expect(requestUrl).toBe(
      "https://api.prodxiv.example/v1/papers/prodxiv%3A2607.000001/revisions/1",
    );
  });

  test("reads structured v2 attribution and status provenance", async () => {
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example/",
      fetch: async () => Response.json(publishedPaperV2),
    });

    expect(await client.getPaperRevision("prodxiv:2608.000001", 1)).toEqual(
      publishedPaperV2,
    );
  });

  test("rejects a communication email without a human writer", async () => {
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example/",
      fetch: async () =>
        Response.json({
          ...publishedPaperV2,
          metadata: {
            ...publishedPaperV2.metadata,
            communication_email: "agent@example.com",
          },
        }),
    });

    await expect(
      client.getPaperRevision("prodxiv:2608.000001", 1),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "network.invalid_response",
      } satisfies Partial<ProdxivApiError>),
    );
  });

  test("rejects empty status evidence tags", async () => {
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example/",
      fetch: async () =>
        Response.json({
          ...publishedPaperV2,
          metadata: {
            ...publishedPaperV2.metadata,
            status: {
              ...publishedPaperV2.metadata.status,
              evidence: [
                {
                  ...publishedPaperV2.metadata.status.evidence[0],
                  tag: "",
                },
              ],
            },
          },
        }),
    });

    await expect(
      client.getPaperRevision("prodxiv:2608.000001", 1),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "network.invalid_response",
      } satisfies Partial<ProdxivApiError>),
    );
  });

  test("keeps historical publications readable without new product metadata", async () => {
    const {
      product_name: _,
      scope: __,
      ...historicalMetadata
    } = publishedPaper.metadata;
    const historicalPaper = {
      ...publishedPaper,
      metadata: historicalMetadata,
    };
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example",
      fetch: async () => Response.json(historicalPaper),
    });

    expect(await client.getPaperRevision("prodxiv:2607.000001", 1)).toEqual(
      historicalPaper,
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
              message: "paper revision does not exist",
            },
          },
          { status: 404 },
        ),
    });

    await expect(
      client.getPaperRevision("prodxiv:2607.000001", 2),
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
      client.getPaperRevision("prodxiv:2607.000001", 1),
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
      client.getPaperRevision("prodxiv:2607.000001", 1),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "network.invalid_response",
      } satisfies Partial<ProdxivApiError>),
    );
  });
});
