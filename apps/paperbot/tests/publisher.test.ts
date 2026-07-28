import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseArguments } from "../src/arguments.ts";
import { run } from "../src/cli.ts";
import { preparePublication } from "../src/publisher.ts";

const token = "paperbot_test_token_with_32_characters";
let workspacePath = "";
let paperPath = "";

beforeEach(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), "paperbot-publish-"));
  paperPath = join(workspacePath, "paper.md");
  const published = await readFile(
    resolve(import.meta.dir, "../../../examples/papers/prodxiv.md"),
    "utf8",
  );
  const submission = published
    .replace(/^paper_id:.*\n/m, "")
    .replace(/^published_at:.*\n/m, "")
    .replace(/^version:.*\n/m, "");
  await writeFile(paperPath, submission);
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

describe("paper publication", () => {
  test("parses explicit non-interactive publication arguments", () => {
    expect(
      parseArguments(["publish", "paper.md", "--format=json", "--yes"]),
    ).toEqual({
      command: "publish",
      input_path: "paper.md",
      format: "json",
      yes: true,
    });
  });

  test("sends a deterministic idempotency key and returns versioned output", async () => {
    let request: Request | undefined;
    const preparation = await preparePublication(paperPath, {
      env: {
        PRODXIV_API_URL: "https://api.prodxiv.example",
        PRODXIV_PUBLISH_TOKEN: token,
      },
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(
          JSON.stringify({
            schema_version: "1",
            paper_id: "prodxiv:2607.000001",
            version: 1,
            published_at: "2026-07-28",
            metadata: {
              schema_version: "1",
              paper_id: "prodxiv:2607.000001",
              title: "prodxiv",
              summary: "summary",
              authors: [{ name: "Author" }],
              published_at: "2026-07-28",
              version: 1,
              status: "concept",
              topics: ["developer_tools"],
              license: "CC BY 4.0",
            },
            source_markdown: "published",
          }),
          {
            status: 201,
            headers: {
              "content-type": "application/json",
              location: "/v1/papers/prodxiv:2607.000001/versions/1",
            },
          },
        );
      },
    });
    const prepared = preparation.publication;
    expect(prepared).toBeDefined();
    if (prepared === undefined) {
      throw new Error("valid fixture should prepare for publication");
    }

    const result = await prepared.publish();

    expect(request?.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(request?.headers.get("idempotency-key")).toBe(
      `paperbot.v1.${prepared.source_sha256}`,
    );
    expect(await request?.json()).toEqual({
      source_markdown: await readFile(paperPath, "utf8"),
    });
    expect(result).toEqual({
      format_version: 1,
      paper_id: "prodxiv:2607.000001",
      version: 1,
      published_at: "2026-07-28",
      location:
        "https://api.prodxiv.example/v1/papers/prodxiv:2607.000001/versions/1",
      source_sha256: prepared.source_sha256,
      replayed: false,
    });
  });

  test("marks an HTTP 200 retry response as recovered", async () => {
    const preparation = await preparePublication(paperPath, {
      env: {
        PRODXIV_API_URL: "https://api.prodxiv.example",
        PRODXIV_PUBLISH_TOKEN: token,
      },
      fetch: async () =>
        new Response(
          JSON.stringify({
            schema_version: "1",
            paper_id: "prodxiv:2607.000001",
            version: 1,
            published_at: "2026-07-28",
            metadata: {},
            source_markdown: "published",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });
    const prepared = preparation.publication;
    expect(prepared).toBeDefined();
    if (prepared === undefined) {
      throw new Error("valid fixture should prepare for publication");
    }

    expect((await prepared.publish()).replayed).toBe(true);
  });

  test("cancels cleanly when interactive publication is not approved", async () => {
    const previousApiUrl = process.env.PRODXIV_API_URL;
    const previousToken = process.env.PRODXIV_PUBLISH_TOKEN;
    process.env.PRODXIV_API_URL = "https://api.prodxiv.example";
    process.env.PRODXIV_PUBLISH_TOKEN = token;
    const stdout: string[] = [];
    const stderr: string[] = [];

    try {
      const exitCode = await run(["publish", paperPath], {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        confirm: async () => false,
      });

      expect(exitCode).toBe(0);
      expect(stdout).toEqual([]);
      expect(stderr.at(-1)).toBe("paperbot: publication cancelled");
    } finally {
      restoreEnvironment("PRODXIV_API_URL", previousApiUrl);
      restoreEnvironment("PRODXIV_PUBLISH_TOKEN", previousToken);
    }
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
