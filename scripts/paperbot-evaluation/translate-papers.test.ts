import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  TranslationJob,
  TranslationResult,
} from "../../packages/api-client/src/client.ts";
import {
  paperBody,
  parseTranslation,
  translatePendingPapers,
} from "./translate-papers.ts";

function job(language: TranslationJob["language"]): TranslationJob {
  const source = '---\nschema_version: "1"\n---\n# Summary\n\nSource.\n';
  return {
    language,
    attempts: 0,
    source_sha256: createHash("sha256").update(source).digest("hex"),
    paper: {
      schema_version: "1",
      paper_id: "prodxiv:2609.000001",
      product_id: "prodxiv-product:2609.000001",
      version: 1,
      published_at: "2026-09-15",
      source_markdown: source,
      metadata: {
        schema_version: "1",
        title: "Source",
        summary: "Summary",
        authors: [{ name: "Author" }],
        status: "concept",
        topics: ["tools"],
      },
    },
  };
}

test("a failed language does not block Japanese without English", async () => {
  const saved: TranslationResult[] = [];
  const report = await translatePendingPapers(
    {
      listTranslationJobs: async () => [job("fr"), job("ja")],
      finishTranslation: async (_job, result) => {
        saved.push(result);
      },
    },
    async (input) => {
      if (input.language === "fr") throw new Error("model failure");
      return {
        title: "概要",
        summary: "説明",
        markdown: "# 概要\n\n説明。",
        model: "test",
      };
    },
  );
  expect(report.completed.map((item) => item.language)).toEqual(["ja"]);
  expect(report.failed).toHaveLength(1);
  expect(saved.map((item) => item.status)).toEqual(["failed", "completed"]);
});

test("English source is copied without a model call and stale hashes fail", async () => {
  let calls = 0;
  const bad = { ...job("ja"), source_sha256: "0".repeat(64) };
  const report = await translatePendingPapers(
    {
      listTranslationJobs: async () => [job("en"), bad],
      finishTranslation: async () => {},
    },
    async () => {
      calls++;
      throw new Error("should not run");
    },
  );
  expect(calls).toBe(0);
  expect(report.completed).toHaveLength(1);
  expect(report.failed).toHaveLength(1);
});

test("rejects malformed output and preserves front matter boundaries", () => {
  expect(() =>
    parseTranslation('{"title":"x","summary":"x","markdown":"x","extra":1}'),
  ).toThrow();
  expect(() =>
    parseTranslation('{"title":"","summary":"x","markdown":"x"}'),
  ).toThrow();
  expect(paperBody("\uFEFF---\r\nx: y\r\n---\r\n# 概要")).toBe("# 概要");
  expect(() => paperBody("# Missing front matter")).toThrow();
});
