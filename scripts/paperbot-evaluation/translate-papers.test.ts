import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ProdxivApiClient,
  ProdxivApiError,
  type TranslationJob,
  type TranslationResult,
} from "../../packages/api-client/src/client.ts";
import type { PiAgentRuntime } from "../../apps/paperbot/src/agent/pi.ts";
import { resolveApiBearerToken } from "../github-actions/oidc.ts";
import { parseTranslation, translatePaper } from "./translation-model.ts";
import { paperBody, translatePendingPapers } from "./translate-papers.ts";

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
        paper_id: "prodxiv:2609.000001",
        version: 1,
        published_at: "2026-09-15",
        license: "CC BY 4.0",
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

test("a long batch requests fresh OIDC credentials for completed and failed results", async () => {
  let now = 0;
  const issuedAt: number[] = [];
  const saved: Array<{ language: string; status: string }> = [];
  const jobs = [job("de"), job("fr"), job("ja"), job("en")];
  const oidcFetch: typeof fetch = Object.assign(
    async () => {
      issuedAt.push(now);
      return Response.json({ value: `header.${now}.signature` });
    },
    { preconnect: fetch.preconnect },
  );
  const client = new ProdxivApiClient({
    api_url: "https://archive.example.test",
    token_provider: () =>
      resolveApiBearerToken(
        "PRODXIV_BOT_TOKEN",
        {
          ACTIONS_ID_TOKEN_REQUEST_URL:
            "https://pipelines.actions.githubusercontent.com/token",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "private-runner-token",
        },
        oidcFetch,
      ),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const issued = Number(
        request.headers.get("authorization")?.split(".")[1],
      );
      if (!Number.isFinite(issued) || now - issued >= 300) {
        return Response.json(
          { error: { code: "auth.unauthorized", message: "expired" } },
          { status: 401 },
        );
      }
      if (request.method === "GET") return Response.json(jobs);
      const body = (await request.json()) as { status: string };
      saved.push({
        language: new URL(request.url).pathname.split("/").at(-1) ?? "",
        status: body.status,
      });
      return new Response(null, { status: 204 });
    },
  });
  const report = await translatePendingPapers(
    client,
    async (input, markdown) => {
      // Each model call alone outlives an OIDC token. Failure recording also
      // needs a fresh credential after an unsuccessful model session.
      now += 7 * 60;
      if (input.language === "fr") throw new Error("model failed");
      return {
        title: "Translated",
        summary: "Summary",
        markdown,
        model: "test",
      };
    },
  );
  expect(report.errors).toEqual([]);
  expect(issuedAt).toEqual([0, 420, 840, 1260, 1260]);
  expect(saved).toEqual([
    { language: "de", status: "completed" },
    { language: "fr", status: "failed" },
    { language: "ja", status: "completed" },
    { language: "en", status: "completed" },
  ]);
  expect(report.completed.map((item) => item.language)).toEqual([
    "de",
    "ja",
    "en",
  ]);
  expect(report.failed).toHaveLength(1);
  expect(report.failed[0]?.failure_recorded).toBe(true);
  expect(report.errors).toEqual([]);
});

test("reports both the save rejection and a failed attempt to record it", async () => {
  const report = await translatePendingPapers(
    {
      listTranslationJobs: async () => [job("en")],
      finishTranslation: async (_job, result) => {
        throw result.status === "completed"
          ? new ProdxivApiError(
              422,
              "translation.invalid",
              "source digest mismatch",
            )
          : new ProdxivApiError(
              401,
              "auth.unauthorized",
              "secret bearer token",
            );
      },
    },
    async () => {
      throw new Error("English must not call the model");
    },
  );
  expect(report.schema_version).toBe("2");
  expect(report.failed[0]).toMatchObject({
    failure_recorded: false,
    error: {
      stage: "save_translation",
      code: "translation.invalid",
      http_status: 422,
      message: "source digest mismatch",
    },
    failure_record_error: {
      stage: "record_failure",
      code: "auth.unauthorized",
      http_status: 401,
    },
  });
  expect(JSON.stringify(report)).not.toContain("secret bearer token");
});

test("queue failures produce a structured report without starting model work", async () => {
  let called = false;
  const report = await translatePendingPapers(
    {
      listTranslationJobs: async () => {
        throw new ProdxivApiError(
          0,
          "auth.token_refresh_failed",
          "private provider detail",
        );
      },
      finishTranslation: async () => {
        called = true;
      },
    },
    async () => {
      called = true;
      throw new Error("unexpected");
    },
  );
  expect(called).toBe(false);
  expect(report).toMatchObject({
    schema_version: "2",
    completed: [],
    failed: [],
    errors: [{ stage: "load_jobs", code: "auth.token_refresh_failed" }],
  });
  expect(JSON.stringify(report)).not.toContain("private provider detail");
});

test("the worker exits nonzero and emits a JSON report when queue loading fails", async () => {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests++;
      expect(new URL(request.url).pathname).toBe("/v1/translation-jobs");
      expect(request.method).toBe("GET");
      return Response.json(
        {
          error: {
            code: "auth.unauthorized",
            message: "private API diagnostic",
          },
        },
        { status: 401 },
      );
    },
  });
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("./translate-papers.ts", import.meta.url)),
      ],
      {
        env: {
          PRODXIV_API_URL: server.url.href,
          PRODXIV_BOT_TOKEN: "test-token-".repeat(4),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(requests).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      schema_version: "2",
      completed: [],
      failed: [],
      errors: [
        { stage: "load_jobs", code: "auth.unauthorized", http_status: 401 },
      ],
    });
    expect(stdout).not.toContain("private API diagnostic");
    expect(stderr).toBe("");
  } finally {
    server.stop(true);
  }
});

const validTranslation = JSON.stringify({
  title: "概要",
  summary: "説明",
  markdown: "# 概要\n\n本文。",
});

function modelRuntime(responses: Array<string | Error>) {
  const prompts: string[] = [];
  const state = { started: 0, disposed: 0 };
  const runtime: Pick<PiAgentRuntime, "model" | "startSession"> = {
    model: "test-model",
    startSession: async (input) => {
      expect(input.role).toBe("translation");
      state.started++;
      return {
        snapshot: () => ({ session_id: "test", session_path: "private.jsonl" }),
        dispose: () => {
          state.disposed++;
        },
        complete: async ({ prompt }) => {
          prompts.push(prompt);
          const response = responses.shift();
          if (response instanceof Error) throw response;
          if (response === undefined)
            throw new Error("unexpected extra model turn");
          return {
            final_text: response,
            provider: "test",
            model: "test-model",
          };
        },
      };
    },
  };
  return { runtime, prompts, state };
}

test("repairs malformed translation JSON once within the same session", async () => {
  const { runtime, prompts, state } = modelRuntime([
    JSON.stringify({
      title: "概要",
      summary: "説明",
      markdown: "本文",
      extra: "private-invalid-output",
    }),
    validTranslation,
  ]);
  expect(
    await translatePaper(runtime, job("ja"), "# Summary\n\nSource."),
  ).toEqual({
    title: "概要",
    summary: "説明",
    markdown: "# 概要\n\n本文。",
    model: "test-model",
  });
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toContain('"target_language":"ja"');
  expect(prompts[1]).toContain("Correct the response format");
  expect(prompts[1]).not.toContain("private-invalid-output");
  expect(state).toEqual({ started: 1, disposed: 1 });
});

test("a valid translation uses one model turn", async () => {
  const { runtime, prompts, state } = modelRuntime([validTranslation]);
  await translatePaper(runtime, job("ja"), "Source.");
  expect(prompts).toHaveLength(1);
  expect(state).toEqual({ started: 1, disposed: 1 });
});

test("repair is bounded and does not block a sibling language", async () => {
  const { runtime, prompts, state } = modelRuntime([
    "bad output",
    "still bad",
    validTranslation,
  ]);
  const results: TranslationResult[] = [];
  const report = await translatePendingPapers(
    {
      listTranslationJobs: async () => [job("fr"), job("ja")],
      finishTranslation: async (_job, result) => {
        results.push(result);
      },
    },
    (input, markdown) => translatePaper(runtime, input, markdown),
  );
  expect(report.failed[0]).toMatchObject({
    language: "fr",
    failure_recorded: true,
    error: { stage: "translate", code: "translation.invalid_json" },
  });
  expect(report.completed.map((item) => item.language)).toEqual(["ja"]);
  expect(results.map((result) => result.status)).toEqual([
    "failed",
    "completed",
  ]);
  expect(prompts).toHaveLength(3);
  expect(state).toEqual({ started: 2, disposed: 2 });
});

test("model transport failures are not retried as formatting problems", async () => {
  const { runtime, prompts, state } = modelRuntime([
    new Error("transport failed"),
  ]);
  await expect(translatePaper(runtime, job("ja"), "Source.")).rejects.toThrow(
    "transport failed",
  );
  expect(prompts).toHaveLength(1);
  expect(state).toEqual({ started: 1, disposed: 1 });
});
