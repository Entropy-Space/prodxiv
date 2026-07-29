import { describe, expect, test } from "bun:test";

import { paperMetadataSchema } from "../src/lib/paper-metadata-schema.ts";

const canonicalMetadata = {
  schema_version: "1",
  paper_id: "prodxiv:2607.000001",
  title: "A published product paper",
  product_name: "A product",
  scope: { kind: "product" },
  summary: "A complete fixture for the published metadata boundary.",
  authors: [{ name: "prodxiv contributors" }],
  published_at: "2026-07-28",
  version: 1,
  status: "concept",
  topics: ["developer_tools"],
  license: "CC BY 4.0",
};

describe("paperMetadataSchema", () => {
  test("normalizes dates inferred by the YAML loader", () => {
    const result = paperMetadataSchema.parse({
      ...canonicalMetadata,
      published_at: new Date("2026-07-28T00:00:00.000Z"),
    });

    expect(result.published_at).toBe("2026-07-28");
  });

  test("does not coerce unrelated values into dates", () => {
    const result = paperMetadataSchema.safeParse({
      ...canonicalMetadata,
      published_at: 20260728,
    });

    expect(result.success).toBe(false);
  });
});
