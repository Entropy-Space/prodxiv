import { describe, expect, test } from "bun:test";
import type { PublicPaperDraft } from "@prodxiv/api-client";

import { readPublicDraftIndex } from "../src/lib/public-draft-index.ts";
import { readPublicDraft } from "../src/lib/public-draft-reader.ts";
import { configuredApiUrl } from "../src/lib/api-url.ts";

const draft = {
  paper_uuid: "00000000-0000-4000-8000-000000000001",
  revision: 1,
  owner_kind: "bot",
  review_status: "pending_review",
  updated_at: "2026-08-28T12:00:00Z",
  metadata: {
    schema_version: "2",
    title: "Pending draft",
    summary: "Unpublished work.",
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
    status: {
      value: "unknown",
      determination: "unverified",
      confidence: "low",
    },
  },
  source_markdown:
    "---\nschema_version: '2'\n---\n# Summary\n\nA draft body.\n",
} satisfies PublicPaperDraft;
const { source_markdown: _, ...summary } = draft;

describe("public draft index", () => {
  test("maps safe metadata and preserves missing metadata as an incomplete entry", async () => {
    let requestUrl = "";
    const result = await readPublicDraftIndex({
      api_url: "https://api.prodxiv.example",
      limit: 5,
      cursor: "page/two",
      fetch: async (input, init) => {
        requestUrl = input.toString();
        expect(init?.credentials).toBe("omit");
        return Response.json({
          drafts: [
            summary,
            {
              ...summary,
              paper_uuid: "00000000-0000-4000-8000-000000000002",
              metadata: null,
            },
          ],
          next_cursor: "page/three",
        });
      },
    });
    expect(requestUrl).toBe(
      "https://api.prodxiv.example/v1/public/drafts?limit=5&cursor=page%2Ftwo",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid public draft list");
    expect(result.next_cursor).toBe("page/three");
    expect(result.drafts[0]).toMatchObject({
      title: "Pending draft",
      authors: ["Example"],
      writers: draft.metadata.writers,
      metadata_available: true,
      href: "/drafts/" + draft.paper_uuid,
    });

    expect(result.drafts[1]).toMatchObject({
      title: "Untitled draft",
      metadata_available: false,
      authors: [],
      topics: [],
    });
  });

  test("distinguishes empty, invalid and failed lists", async () => {
    expect(
      await readPublicDraftIndex({
        api_url: "https://api.prodxiv.example",
        fetch: async () => Response.json({ drafts: [] }),
      }),
    ).toEqual({ ok: true, drafts: [] });
    expect(await readPublicDraftIndex({})).toMatchObject({
      ok: false,
      status: 503,
    });
    expect(
      await readPublicDraftIndex({
        api_url: "https://api.prodxiv.example",
        cursor: "",
      }),
    ).toMatchObject({ ok: false, status: 400 });
    const failed = await readPublicDraftIndex({
      api_url: "https://api.prodxiv.example",
      fetch: async () => {
        throw new Error("secret backend detail");
      },
    });
    expect(failed).toMatchObject({ ok: false, status: 502 });
    expect(JSON.stringify(failed)).not.toContain("secret");
  });
});

describe("public draft reader", () => {
  test("renders an unpublished draft and safe writer provenance", async () => {
    const result = await readPublicDraft({
      paper_uuid: draft.paper_uuid,
      api_url: "https://api.prodxiv.example",
      fetch: async () => Response.json({ kind: "draft", draft }),
    });
    expect(result.ok && result.kind).toBe("draft");
    if (!result.ok || result.kind !== "draft")
      throw new Error("expected readable draft");
    expect(result.rendered.html).toContain('<h1 id="summary">Summary</h1>');
    expect(result.rendered.html).not.toContain("schema_version");
    expect(result.draft.owner_kind).toBe("bot");
    expect(result.incomplete).toBe(false);
  });

  test("uses the sanitizer when front matter is malformed or metadata is absent", async () => {
    const result = await readPublicDraft({
      paper_uuid: draft.paper_uuid,
      api_url: "https://api.prodxiv.example",
      fetch: async () =>
        Response.json({
          kind: "draft",
          draft: {
            ...draft,
            metadata: null,
            source_markdown:
              "---\ntitle: [broken YAML\n---\n# Summary\n<script>alert('bad')</script>\n\n[unsafe](javascript:alert(1))",
          },
        }),
    });
    if (!result.ok || result.kind !== "draft")
      throw new Error("expected readable incomplete draft");
    expect(result.incomplete).toBe(true);
    expect(result.rendered.html).toContain("Summary");
    expect(result.rendered.html).not.toContain("broken YAML");
    expect(result.rendered.html).not.toContain("<script");
    expect(result.rendered.html).not.toContain("javascript:");
  });

  test("resolves a published draft link to an exact short-ID URL", async () => {
    expect(
      await readPublicDraft({
        paper_uuid: draft.paper_uuid,
        api_url: "https://api.prodxiv.example",
        fetch: async () =>
          Response.json({
            kind: "published",
            paper_id: "prodxiv:2608.000001",
            version: 3,
          }),
      }),
    ).toEqual({
      ok: true,
      kind: "published",
      paper_id: "prodxiv:2608.000001",
      version: 3,
      href: "/papers/2608.000001/v3",
    });
  });

  test("rejects invalid UUIDs before fetching and does not reveal nonpublic states", async () => {
    let fetched = false;
    expect(
      await readPublicDraft({
        paper_uuid: "latest",
        api_url: "https://api.prodxiv.example",
        fetch: async () => {
          fetched = true;
          return Response.json({});
        },
      }),
    ).toMatchObject({ ok: false, error: { status: 400 } });
    expect(fetched).toBe(false);
    expect(
      await readPublicDraft({
        paper_uuid: draft.paper_uuid,
        api_url: "https://api.prodxiv.example",
        fetch: async () =>
          Response.json(
            {
              error: {
                code: "draft.not_found",
                message: "rejected by private author",
              },
            },
            { status: 404 },
          ),
      }),
    ).toEqual({
      ok: false,
      error: {
        status: 404,
        title: "Draft not available",
        message:
          "This draft does not exist or is not available for public reading.",
      },
    });
  });

  test("fails closed on an unsafe metadata URL without leaking the response", async () => {
    expect(
      await readPublicDraft({
        paper_uuid: draft.paper_uuid,
        api_url: "https://api.prodxiv.example",
        fetch: async () =>
          Response.json({
            kind: "draft",
            draft: {
              ...draft,
              metadata: {
                ...draft.metadata,
                product_url: "javascript:alert(1)",
              },
            },
          }),
      }),
    ).toMatchObject({ ok: false, error: { status: 502 } });
  });
});

describe("anonymous API configuration", () => {
  test("rejects embedded credentials, query strings, fragments and remote HTTP", () => {
    for (const value of [
      "https://reviewer:secret@api.prodxiv.example",
      "https://api.prodxiv.example?token=secret",
      "https://api.prodxiv.example#fragment",
      "http://api.prodxiv.example",
    ])
      expect(configuredApiUrl(value)).toBeUndefined();
    expect(configuredApiUrl("http://[::1]:8080")).toBe("http://[::1]:8080");
  });
});
