import { describe, expect, test } from "bun:test";

import {
  canonicalPaperIdFromSlug,
  paperSlugFromCanonicalId,
  paperVersionFromSlug,
  publicPaperPath,
} from "../src/public-paper-url.ts";

describe("public paper URLs", () => {
  test("formats canonical identifiers without exposing the namespace", () => {
    expect(publicPaperPath("prodxiv:2607.000001", 1)).toBe(
      "/papers/2607.000001/v1",
    );
  });

  test("parses public identifiers and versions at the route boundary", () => {
    expect(canonicalPaperIdFromSlug("2607.00000A")).toBe("prodxiv:2607.00000A");
    expect(paperSlugFromCanonicalId("prodxiv:2607.00000A")).toBe("2607.00000A");
    expect(paperVersionFromSlug("v12")).toBe(12);
  });

  test("rejects malformed and ambiguous route values", () => {
    expect(canonicalPaperIdFromSlug("prodxiv:2607.000001")).toBeUndefined();
    expect(canonicalPaperIdFromSlug("2607.00000a")).toBeUndefined();
    expect(canonicalPaperIdFromSlug("2607.00000I")).toBeUndefined();
    expect(paperSlugFromCanonicalId("2607.000001")).toBeUndefined();
    expect(paperVersionFromSlug("1")).toBeUndefined();
    expect(paperVersionFromSlug("v0")).toBeUndefined();
    expect(() => publicPaperPath("2607.000001", 1)).toThrow(TypeError);
  });
});
