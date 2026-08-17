import { describe, expect, test } from "bun:test";

import {
  draftReviewClient,
  isSameOriginSubmission,
} from "../src/lib/draft-review-auth.ts";

describe("draft review authentication", () => {
  test("accepts a user-supplied Basic password without configuring it on web", () => {
    const request = new Request("https://prodxiv.example/drafts", {
      headers: {
        authorization: `Basic ${Buffer.from("reviewer:private-token").toString("base64")}`,
      },
    });

    expect(
      draftReviewClient(request, "https://api.prodxiv.example"),
    ).toBeDefined();
    expect(
      draftReviewClient(
        new Request("https://prodxiv.example/drafts"),
        "https://api.prodxiv.example",
      ),
    ).toBeUndefined();
  });

  test("requires same-origin browser submissions", () => {
    expect(
      isSameOriginSubmission(
        new Request("https://prodxiv.example/drafts/example", {
          method: "POST",
          headers: { origin: "https://prodxiv.example" },
        }),
      ),
    ).toBe(true);
    expect(
      isSameOriginSubmission(
        new Request("https://prodxiv.example/drafts/example", {
          method: "POST",
          headers: { origin: "https://attacker.example" },
        }),
      ),
    ).toBe(false);
  });
});
