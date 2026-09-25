import { describe, expect, test } from "bun:test";

import {
  ProdxivApiClient,
  type PaperMetadata,
  type PublishedPaper,
  type PublicPaperDraft,
} from "../src/client.ts";

const metadata = {
  schema_version: "2",
  title: "Public draft fixture",
  summary: "A pending product paper.",
  authors: [{ name: "Example", kind: "organization" }],
  writers: [
    {
      kind: "agent",
      name: "paperbot",
      model: "deepseek-v4-flash",
      tool_version: "1.0.0",
    },
  ],
  topics: ["developer_tools"],
  status: { value: "unknown", determination: "unverified", confidence: "low" },
} satisfies PaperMetadata;

const draft = {
  paper_uuid: "00000000-0000-4000-8000-000000000001",
  revision: 2,
  owner_kind: "bot",
  review_status: "pending_review",
  updated_at: "2026-08-28T12:00:00.123456Z",
  metadata,
  source_markdown: "# Summary\n\nDraft content.",
} satisfies PublicPaperDraft;
const { source_markdown: _, ...draftSummary } = draft;

const paper = {
  schema_version: "2",
  paper_id: "prodxiv:2608.000001",
  product_id: "prodxiv-product:2608.000001",
  version: 2,
  published_at: "2026-08-28",
  source_markdown: '---\nschema_version: "2"\n---\n# Summary\n',
  metadata: {
    ...metadata,
    paper_id: "prodxiv:2608.000001",
    published_at: "2026-08-28",
    version: 2,
    license: "CC BY 4.0",
  },
} satisfies PublishedPaper;
const { source_markdown: __, ...paperSummary } = paper;

function clientFor(body: unknown): ProdxivApiClient {
  return new ProdxivApiClient({
    api_url: "https://api.prodxiv.example",
    fetch: async () => Response.json(body),
  });
}

describe("anonymous public reads", () => {
  test.each(["static token", "token provider"])(
    "never uses a configured %s or ambient cookies for public reads",
    async (source) => {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      let provider_calls = 0;
      const client = new ProdxivApiClient({
        api_url: "https://api.prodxiv.example",
        ...(source === "static token"
          ? { token: "private-review-token" }
          : {
              token_provider: async () => {
                provider_calls += 1;
                throw new Error("public reads must not resolve credentials");
              },
            }),
        fetch: async (input, init) => {
          const url = input.toString();
          requests.push({ url, init });
          if (url.includes("/public/drafts?")) {
            return Response.json({
              drafts: [draftSummary],
              next_cursor: "next/page",
            });
          }
          if (url.endsWith("/public/drafts/" + draft.paper_uuid)) {
            return Response.json({ kind: "draft", draft });
          }
          if (url.endsWith("/topics"))
            return Response.json({ topics: ["developer_tools"] });
          if (url.endsWith("/revisions"))
            return Response.json({ revisions: [paperSummary] });
          if (url.endsWith("/translations")) return Response.json([]);
          if (url.includes("/revisions/")) return Response.json(paper);
          if (url.endsWith("/github/trending")) {
            return Response.json({
              requested_language: "any",
              snapshots: [],
              available_languages: [],
            });
          }
          return Response.json({ papers: [paperSummary] });
        },
      });

      expect(
        await client.listPublicDrafts({ limit: 5, cursor: "current/page" }),
      ).toEqual({
        drafts: [draftSummary],
        next_cursor: "next/page",
      });
      expect(await client.getPublicDraft(draft.paper_uuid)).toEqual({
        kind: "draft",
        draft,
      });
      await client.listPapers({
        q: "source & evidence",
        topic: "developer_tools",
      });
      await client.listPaperTopics();
      await client.listPaperRevisions(paper.paper_id);
      await client.getPaperRevision(paper.paper_id, paper.version);
      await client.getPaperVersion(paper.paper_id, paper.version);
      await client.listPaperTranslations(paper.paper_id, paper.version);
      await client.getGitHubTrending();
      expect(provider_calls).toBe(0);
      expect(requests.length).toBe(9);
      expect(requests[0]?.url).toBe(
        "https://api.prodxiv.example/v1/public/drafts?limit=5&cursor=current%2Fpage",
      );
      expect(requests[2]?.url).toContain(
        "q=source+%26+evidence&topic=developer_tools",
      );
      for (const request of requests) {
        expect(request.init?.credentials).toBe("omit");
        expect(request.init?.redirect).toBe("error");
        expect(new Headers(request.init?.headers).has("authorization")).toBe(
          false,
        );
      }
    },
  );

  test("rejects API URLs containing credentials without fetching", async () => {
    let fetched = false;
    const client = new ProdxivApiClient({
      api_url: "https://reviewer:secret@api.prodxiv.example",
      fetch: async () => {
        fetched = true;
        return Response.json({ drafts: [] });
      },
    });
    await expect(client.listPublicDrafts()).rejects.toMatchObject({
      code: "request.invalid_api_url",
    });
    expect(fetched).toBe(false);
  });

  test("drops management fields and accepts explicitly missing draft metadata", async () => {
    const result = await clientFor({
      kind: "draft",
      draft: {
        ...draft,
        metadata: null,
        reviewed_by: "private-author",
        rejection_reason: "private-note",
        source_snapshot: "/private/run",
      },
    }).getPublicDraft(draft.paper_uuid);
    expect(result).toEqual({
      kind: "draft",
      draft: {
        paper_uuid: draft.paper_uuid,
        revision: draft.revision,
        owner_kind: draft.owner_kind,
        review_status: draft.review_status,
        updated_at: draft.updated_at,
        source_markdown: draft.source_markdown,
      },
    });
  });

  test("keeps historically valid credential-bearing HTTP metadata and exact source intact", async () => {
    const link = "https://example-user:example-password@example.com/product";
    const historic = {
      ...paper,
      metadata: {
        ...paper.metadata,
        product_url: link,
        repository_url: link,
        authors: [
          { name: "Example", kind: "organization" as const, url: link },
        ],
        status: {
          ...metadata.status,
          evidence: [{ kind: "github_release" as const, url: link }],
        },
      },
      source_markdown:
        "---\nproduct_url: " +
        link +
        "\n---\n# Summary\n\nOriginal immutable source.\n",
    };
    const actual = await clientFor(historic).getPaperRevision(
      paper.paper_id,
      paper.version,
    );
    expect(actual).toEqual(historic);
    expect(actual.source_markdown).toBe(historic.source_markdown);
    const { source_markdown: _, ...summary } = historic;
    expect(
      (await clientFor({ papers: [summary] }).listPapers()).papers,
    ).toEqual([summary]);
  });

  test("retains the stronger anonymous-link boundary for public draft metadata", async () => {
    const link = "https://example-user:example-password@example.com/product";
    const invalidMetadata = [
      { ...metadata, product_url: link },
      { ...metadata, repository_url: link },
      {
        ...metadata,
        authors: [{ name: "Example", kind: "organization", url: link }],
      },
      {
        ...metadata,
        status: {
          ...metadata.status,
          evidence: [{ kind: "github_release", url: link }],
        },
      },
    ];
    for (const metadata of invalidMetadata) {
      await expect(
        clientFor({
          drafts: [{ ...draftSummary, metadata }],
        }).listPublicDrafts(),
      ).rejects.toMatchObject({ code: "network.invalid_response" });
    }
  });

  test("accepts canonicalizable IDs inside draft metadata without changing identity or source", async () => {
    const lowercase = {
      ...draft,
      metadata: {
        ...metadata,
        paper_id: "prodxiv:2608.00000a",
        relationships: [
          { kind: "inspired_by" as const, paper_id: "prodxiv:2608.00000b" },
        ],
      },
    };
    expect(
      await clientFor({ kind: "draft", draft: lowercase }).getPublicDraft(
        draft.paper_uuid,
      ),
    ).toEqual({ kind: "draft", draft: lowercase });
    const { source_markdown: _, ...summary } = lowercase;
    expect(
      (await clientFor({ drafts: [summary] }).listPublicDrafts()).drafts,
    ).toEqual([summary]);
    const invalid = {
      ...lowercase,
      metadata: { ...lowercase.metadata, paper_id: "prodxiv:2608.00000l" },
    };
    await expect(
      clientFor({ kind: "draft", draft: invalid }).getPublicDraft(
        draft.paper_uuid,
      ),
    ).rejects.toMatchObject({ code: "network.invalid_response" });
  });

  test("does not relax canonical root publication identity", async () => {
    const lowercase = {
      ...paper,
      paper_id: "prodxiv:2608.00000a",
      metadata: { ...paper.metadata, paper_id: "prodxiv:2608.00000a" },
    };
    await expect(
      clientFor(lowercase).getPaperRevision(
        "prodxiv:2608.00000A",
        paper.version,
      ),
    ).rejects.toMatchObject({ code: "network.invalid_response" });
    await expect(
      clientFor({
        kind: "published",
        paper_id: lowercase.paper_id,
        version: 1,
      }).getPublicDraft(draft.paper_uuid),
    ).rejects.toMatchObject({ code: "network.invalid_response" });
  });

  test("keeps legacy stored topics readable, discoverable and filterable", async () => {
    const legacy = {
      ...paper,
      metadata: { ...paper.metadata, topics: ["developer__tools"] },
    };
    expect(
      await clientFor(legacy).getPaperRevision(paper.paper_id, paper.version),
    ).toEqual(legacy);
    expect(
      await clientFor({
        topics: ["developer__tools", "new_topic"],
      }).listPaperTopics(),
    ).toEqual({ topics: ["developer__tools", "new_topic"] });
    let requestUrl = "";
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example",
      fetch: async (input) => {
        requestUrl = input.toString();
        return Response.json({ papers: [legacy] });
      },
    });
    expect(
      (await client.listPapers({ topic: "developer__tools" })).papers[0]
        ?.metadata.topics,
    ).toEqual(["developer__tools"]);
    expect(new URL(requestUrl).searchParams.get("topic")).toBe(
      "developer__tools",
    );
    await expect(
      clientFor({
        drafts: [
          {
            ...draftSummary,
            metadata: { ...metadata, topics: ["developer__tools"] },
          },
        ],
      }).listPublicDrafts(),
    ).rejects.toMatchObject({ code: "network.invalid_response" });
  });

  test("rejects nonpending states, malformed metadata and unsafe URLs", async () => {
    const invalidDrafts = [
      { ...draft, review_status: "approved" },
      { ...draft, review_status: "rejected" },
      { ...draft, owner_kind: "human" },
      { ...draft, revision: 0 },
      { ...draft, revision: 2_147_483_648 },
      { ...draft, updated_at: "2026-02-31T00:00:00Z" },
      { ...draft, metadata: { ...metadata, title: 123 } },
      {
        ...draft,
        metadata: { ...metadata, product_url: "javascript:alert(1)" },
      },
      {
        ...draft,
        metadata: { ...metadata, repository_url: "data:text/html,unsafe" },
      },
      {
        ...draft,
        metadata: {
          ...metadata,
          authors: [
            { name: "Example", kind: "person", url: "javascript:alert(1)" },
          ],
        },
      },
      {
        ...draft,
        metadata: {
          ...metadata,
          writers: [
            {
              kind: "agent",
              name: "paperbot",
              model: "model",
              tool_version: { private: true },
            },
          ],
        },
      },
      { ...draft, metadata: { ...metadata, topics: ["not a topic"] } },
    ];
    for (const invalid of invalidDrafts) {
      await expect(
        clientFor({ kind: "draft", draft: invalid }).getPublicDraft(
          draft.paper_uuid,
        ),
      ).rejects.toMatchObject({ code: "network.invalid_response" });
    }
  });

  test("rejects a different UUID and duplicate list entries", async () => {
    await expect(
      clientFor({
        kind: "draft",
        draft: { ...draft, paper_uuid: "00000000-0000-4000-8000-000000000002" },
      }).getPublicDraft(draft.paper_uuid),
    ).rejects.toMatchObject({ code: "network.invalid_response" });
    await expect(
      clientFor({ drafts: [draftSummary, draftSummary] }).listPublicDrafts(),
    ).rejects.toMatchObject({ code: "network.invalid_response" });
  });

  test("only resolves a published mapping to a canonical ID and bounded revision", async () => {
    const valid = {
      kind: "published" as const,
      paper_id: paper.paper_id,
      version: 2,
    };
    expect(await clientFor(valid).getPublicDraft(draft.paper_uuid)).toEqual(
      valid,
    );
    for (const invalid of [
      { ...valid, paper_id: "https://elsewhere.example" },
      { ...valid, paper_id: "2608.000001" },
      { ...valid, version: 0 },
      { ...valid, version: 4_294_967_296 },
    ]) {
      await expect(
        clientFor(invalid).getPublicDraft(draft.paper_uuid),
      ).rejects.toMatchObject({ code: "network.invalid_response" });
    }
  });

  test("preserves structured API failures", async () => {
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example",
      fetch: async () =>
        Response.json(
          {
            error: { code: "storage.internal", message: "reading failed" },
          },
          { status: 500 },
        ),
    });
    await expect(client.listPublicDrafts()).rejects.toMatchObject({
      status: 500,
      code: "storage.internal",
    });
  });

  test("validates IDs, revisions, limits and filters before fetching", async () => {
    let fetched = false;
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example",
      fetch: async () => {
        fetched = true;
        return Response.json({});
      },
    });
    await expect(client.getPublicDraft("latest")).rejects.toMatchObject({
      code: "draft.invalid_uuid",
    });
    await expect(client.listPublicDrafts({ limit: 0 })).rejects.toMatchObject({
      code: "request.invalid_limit",
    });
    await expect(client.listPublicDrafts({ cursor: "" })).rejects.toMatchObject(
      { code: "request.invalid_cursor" },
    );
    await expect(
      client.listPapers({ q: "x".repeat(201) }),
    ).rejects.toMatchObject({ code: "request.invalid_query" });
    await expect(client.listPapers({ q: "bad\nquery" })).rejects.toMatchObject({
      code: "request.invalid_query",
    });
    await expect(
      client.listPapers({ topic: "Developer Tools" }),
    ).rejects.toMatchObject({ code: "request.invalid_topic" });
    await expect(
      client.getPaperRevision(paper.paper_id, 4_294_967_296),
    ).rejects.toMatchObject({ code: "request.invalid_revision" });
    await expect(
      client.listPaperRevisions("2608.000001"),
    ).rejects.toMatchObject({ code: "request.invalid_paper_id" });
    expect(fetched).toBe(false);
  });

  test("bounds search by Unicode characters and omits blank filters", async () => {
    const urls: string[] = [];
    const client = new ProdxivApiClient({
      api_url: "https://api.prodxiv.example",
      fetch: async (input) => {
        urls.push(input.toString());
        return Response.json({ papers: [] });
      },
    });
    await client.listPapers({ q: "😀".repeat(200) });
    await client.listPapers({ q: " ", topic: " " });
    expect(new URL(urls[0]!).searchParams.get("q")).toBe("😀".repeat(200));
    expect(urls[1]).toBe("https://api.prodxiv.example/v1/papers");
  });

  test("rejects mismatched exact publications and invalid revision histories", async () => {
    await expect(
      clientFor(paper).getPaperRevision(paper.paper_id, 1),
    ).rejects.toMatchObject({ code: "network.invalid_response" });
    const other = {
      ...paperSummary,
      paper_id: "prodxiv:2608.000002",
      metadata: { ...paper.metadata, paper_id: "prodxiv:2608.000002" },
    };
    for (const revisions of [
      [],
      [paperSummary, paperSummary],
      [other],
      [{ ...paperSummary, version: 0 }],
    ]) {
      await expect(
        clientFor({ revisions }).listPaperRevisions(paper.paper_id),
      ).rejects.toMatchObject({ code: "network.invalid_response" });
    }
  });

  test("sorts only authoritative versions and rejects malformed topics", async () => {
    const older = {
      ...paperSummary,
      version: 1,
      metadata: { ...paper.metadata, version: 1 },
    };
    expect(
      (
        await clientFor({
          revisions: [older, paperSummary],
        }).listPaperRevisions(paper.paper_id)
      ).revisions.map((entry) => entry.version),
    ).toEqual([2, 1]);
    for (const topics of [["Developer Tools"], ["valid", "valid"], [2]]) {
      await expect(
        clientFor({ topics }).listPaperTopics(),
      ).rejects.toMatchObject({ code: "network.invalid_response" });
    }
  });
});
