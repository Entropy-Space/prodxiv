import { expect, test } from "bun:test";

import {
  parseDraftResponse,
  parseGeneratedTitleDraftResponse,
} from "../src/agent/responses.ts";

const draft = {
  action: "submit_draft" as const,
  summary: "DuckDB provides in-process analytical data processing.",
  topics: ["analytics"],
  markdown: "# Summary\n\nA complete paper body.",
  evidence_ids: ["evidence:001"],
  assumptions: [],
  unresolved_questions: [],
};

test("accepts a branded thesis title only for the first generated-title response", () => {
  const response = JSON.stringify({
    ...draft,
    title: "DuckDB: In-Process Analytics Without a Separate Service",
  });

  expect(parseGeneratedTitleDraftResponse(response, "duckdb")).toEqual({
    ...draft,
    title: "DuckDB: In-Process Analytics Without a Separate Service",
  });
  expect(() => parseDraftResponse(response)).toThrow("unknown field: title");

  expect(
    parseGeneratedTitleDraftResponse(
      JSON.stringify({
        ...draft,
        title: "Acme: Cloud: Regional Workloads Without Shared State",
      }),
      "Acme: Cloud",
    ).title,
  ).toBe("Acme: Cloud: Regional Workloads Without Shared State");
});

test("rejects missing, generic, and wrong-product generated titles", () => {
  for (const title of [
    undefined,
    "duckdb research draft",
    "DuckDB: Research Draft",
    "DuckDB: A Research Draft on In-Process Analytics",
    "Other: In-Process Analytics",
  ]) {
    expect(() =>
      parseGeneratedTitleDraftResponse(
        JSON.stringify({ ...draft, ...(title === undefined ? {} : { title }) }),
        "duckdb",
      ),
    ).toThrow("authoring.title");
  }
});
