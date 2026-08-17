import { describe, expect, test } from "bun:test";

import {
  ProdxivApiClient,
  ProdxivApiError,
  type PaperDraft,
  type PublishedPaper,
} from "../src/client.ts";

const draft = {
  paper_uuid: "00000000-0000-4000-8000-000000000001",
  revision: 1,
  owner_kind: "author",
  source_markdown: "# Working notes\n",
  review: { status: "pending_review" },
  created_at: "2026-08-15T00:00:00.000000Z",
  updated_at: "2026-08-15T00:00:00.000000Z",
} satisfies PaperDraft;

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
  test("manages UUID-scoped drafts and retained revisions", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example/",
      token: "draft-token",
      fetch: async (input, init) => {
        const url = input.toString();
        requests.push({ url, init });
        const pathname = new URL(url).pathname;
        if (init?.method === "POST") {
          return Response.json(draft, { status: 201 });
        }
        if (init?.method === "PUT") {
          return Response.json({
            ...draft,
            revision: 2,
            source_markdown: "# Revised notes\n",
            updated_at: "2026-08-15T00:00:01.000000Z",
          });
        }
        if (init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (pathname.endsWith("/revisions/1")) {
          const { updated_at: _, ...revision } = draft;
          return Response.json(revision);
        }
        if (pathname.endsWith("/revisions")) {
          const { source_markdown: _, updated_at: __, ...summary } = draft;
          return Response.json({
            revisions: [summary],
            retained_revision_limit: 5,
          });
        }
        if (pathname === "/v1/drafts") {
          const { source_markdown: _, ...summary } = draft;
          return Response.json({ drafts: [summary] });
        }
        return Response.json(draft);
      },
    });

    expect(
      await client.createDraft({
        source_markdown: draft.source_markdown,
        idempotency_key: "draft-create-client-1",
      }),
    ).toEqual(draft);
    expect(
      (
        await client.listDrafts({
          review_status: "pending_review",
          owner_kind: "author",
        })
      ).drafts[0]?.paper_uuid,
    ).toBe(draft.paper_uuid);
    expect(await client.getDraft(draft.paper_uuid)).toEqual(draft);
    expect(
      await client.updateDraft(draft.paper_uuid, {
        source_markdown: "# Revised notes\n",
        expected_revision: 1,
      }),
    ).toEqual(expect.objectContaining({ revision: 2 }));
    expect(
      (await client.listDraftRevisions(draft.paper_uuid))
        .retained_revision_limit,
    ).toBe(5);
    expect(await client.getDraftRevision(draft.paper_uuid, 1)).toEqual(
      expect.objectContaining({ revision: 1 }),
    );
    await client.deleteDraft(draft.paper_uuid, 2);

    expect(requests.map((request) => request.url)).not.toContain(
      "https://api.prodxiv.example/v1/drafts/latest",
    );
    expect(requests[1]?.url).toBe(
      "https://api.prodxiv.example/v1/drafts?review_status=pending_review&owner_kind=author",
    );
    expect(requests[0]?.init?.headers).toEqual(
      expect.objectContaining({
        authorization: "Bearer draft-token",
        "idempotency-key": "draft-create-client-1",
      }),
    );
    expect(requests[3]?.init?.headers).toEqual(
      expect.objectContaining({ "if-match": '"1"' }),
    );
    expect(requests[6]?.init?.headers).toEqual(
      expect.objectContaining({ "if-match": '"2"' }),
    );
  });

  test("approves and rejects exact draft revisions", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example",
      token: "draft-token",
      fetch: async (input, init) => {
        requests.push({ url: input.toString(), init });
        const rejected = input.toString().endsWith("/reject");
        return Response.json({
          ...draft,
          review: rejected
            ? {
                status: "rejected",
                reviewed_revision: 1,
                reviewed_by: "author",
                reviewed_at: "2026-08-17T00:00:00.000000Z",
                rejection_reason: "Needs revision",
              }
            : {
                status: "approved",
                reviewed_revision: 1,
                reviewed_by: "author",
                reviewed_at: "2026-08-17T00:00:00.000000Z",
              },
        });
      },
    });

    expect(
      (await client.approveDraft(draft.paper_uuid, { expected_revision: 1 }))
        .review.status,
    ).toBe("approved");
    expect(
      (
        await client.rejectDraft(draft.paper_uuid, {
          expected_revision: 1,
          reason: "Needs revision",
        })
      ).review.status,
    ).toBe("rejected");

    expect(requests[0]?.url).toBe(
      `https://api.prodxiv.example/v1/drafts/${draft.paper_uuid}/approve`,
    );
    expect(requests[0]?.init?.headers).toEqual(
      expect.objectContaining({ "if-match": '"1"' }),
    );
    expect(requests[1]?.url).toBe(
      `https://api.prodxiv.example/v1/drafts/${draft.paper_uuid}/reject`,
    );
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      reason: "Needs revision",
    });
  });

  test("publishes one saved draft revision without resending Markdown", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example",
      token: "draft-token",
      fetch: async (input, init) => {
        requestUrl = input.toString();
        requestInit = init;
        return Response.json(publishedPaper, {
          status: 201,
          headers: {
            location: "/v1/papers/prodxiv:2607.000001/revisions/1",
          },
        });
      },
    });

    const result = await client.publishDraft(draft.paper_uuid, {
      expected_revision: 1,
      idempotency_key: "draft-publish-client-1",
      product_id: "prodxiv-product:2607.000001",
    });

    expect(requestUrl).toBe(
      `https://api.prodxiv.example/v1/drafts/${draft.paper_uuid}/publish`,
    );
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toEqual(
      expect.objectContaining({
        authorization: "Bearer draft-token",
        "idempotency-key": "draft-publish-client-1",
        "if-match": '"1"',
      }),
    );
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      product_id: "prodxiv-product:2607.000001",
    });
    expect(String(requestInit?.body)).not.toContain("source_markdown");
    expect(result).toEqual({
      paper: publishedPaper,
      location: "/v1/papers/prodxiv:2607.000001/revisions/1",
      replayed: false,
    });
  });

  test("approves and publishes one saved draft revision atomically", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example",
      token: "author-token",
      fetch: async (input, init) => {
        requestUrl = input.toString();
        requestInit = init;
        return Response.json(publishedPaper, {
          status: 201,
          headers: {
            location: "/v1/papers/prodxiv:2607.000001/revisions/1",
          },
        });
      },
    });

    await client.approveAndPublishDraft(draft.paper_uuid, {
      expected_revision: 1,
      idempotency_key: "draft-approve-publish-client-1",
    });

    expect(requestUrl).toBe(
      `https://api.prodxiv.example/v1/drafts/${draft.paper_uuid}/approve-and-publish`,
    );
    expect(requestInit?.headers).toEqual(
      expect.objectContaining({
        authorization: "Bearer author-token",
        "idempotency-key": "draft-approve-publish-client-1",
        "if-match": '"1"',
      }),
    );
  });

  test("requires a token and canonical UUID for private drafts", async () => {
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example",
      fetch: async () => Response.json(draft),
    });

    await expect(client.listDrafts()).rejects.toEqual(
      expect.objectContaining({ code: "auth.token_missing" }),
    );
    const authorized = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example",
      token: "draft-token",
      fetch: async () => Response.json(draft),
    });
    await expect(authorized.getDraft("latest")).rejects.toEqual(
      expect.objectContaining({ code: "draft.invalid_uuid" }),
    );
  });

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
