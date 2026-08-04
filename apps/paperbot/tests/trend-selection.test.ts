import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExitCode, PaperbotError } from "@prodxiv/paperbot-core";
import type {
  CollectionOptions,
  TrendingEntry,
  TrendingSnapshot,
} from "@prodxiv/paperbot-source/github-trending";
import {
  parseTrendSelectionResponse,
  runTrendSelection,
  type TrendSelectionRuntime,
} from "../src/agent/trend-selection.ts";
import type { ModelCompletion } from "../src/agent/types.ts";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
});

describe("runTrendSelection", () => {
  test("captures today's all-language snapshot and writes a source-owned ranked selection", async () => {
    const workspace = await createWorkspace();
    const outputPath = join(workspace, "trend-run");
    const snapshot = trendingSnapshot();
    const runtime = new FakeTrendRuntime([
      selectionResponse(snapshot.entries.slice(0, 10)),
    ]);
    let collectionOptions: CollectionOptions | undefined;
    const clock = fixedClock(
      "2026-08-04T01:02:03.456Z",
      "2026-08-04T01:02:04.789Z",
    );

    const result = await runTrendSelection(
      {
        output_path: outputPath,
        allow_remote_model: true,
        model: "deepseek-v4-flash",
      },
      {
        collect_trending: async (options) => {
          collectionOptions = options;
          return { snapshots: [snapshot], failures: [] };
        },
        create_runtime: (model) => {
          expect(model).toBe("deepseek-v4-flash");
          return runtime;
        },
        now: clock,
      },
    );

    expect(collectionOptions).toEqual({
      snapshot_date: "2026-08-04",
      captured_at: "2026-08-04T01:02:03Z",
      languages: [null],
    });
    expect(runtime.started_inputs).toEqual([
      { role: "trend_selection", run_path: outputPath },
    ]);
    expect(runtime.prompts).toHaveLength(1);
    expect(runtime.prompts[0]).toContain("<paperbot_trending_candidates>");
    expect(runtime.prompts[0]).toContain("example/repo-12");
    expect(runtime.prompts[0]).toContain("do not simply sort by popularity");
    expect(runtime.disposed).toBe(1);

    expect(result).toMatchObject({
      output_path: outputPath,
      snapshot_path: join(outputPath, "snapshot.json"),
      selection_path: join(outputPath, "selection.json"),
      selection: {
        schema_version: "1",
        generated_at: "2026-08-04T01:02:04Z",
        selection_policy: "product_paper_interest_v1",
        snapshot: {
          snapshot_date: "2026-08-04",
          candidate_count: 12,
        },
        agent: {
          provider: "fake-pi",
          model: "deepseek-v4-flash",
          session_id: "fake-trend-selection",
          turn_count: 1,
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      },
    });
    expect(result.selection.selected_repositories).toHaveLength(10);
    const firstCandidate = snapshot.entries[0]!;
    expect(result.selection.selected_repositories[0]).toEqual({
      rank: 1,
      ...firstCandidate,
      repository_url: "https://github.com/example/repo-1",
      reason: "Candidate 1 merits deeper product-paper research.",
    });

    const [savedSnapshot, savedSelection] = await Promise.all([
      readJson(join(outputPath, "snapshot.json")),
      readJson(join(outputPath, "selection.json")),
    ]);
    expect(savedSnapshot).toEqual(snapshot);
    expect(savedSelection).toEqual(result.selection);
    expect(JSON.stringify(savedSelection)).not.toMatch(
      /candidateCount|generatedAt|repositoryFullName/,
    );
    expect((await stat(outputPath)).mode & 0o777).toBe(0o700);
    expect((await stat(join(outputPath, "snapshot.json"))).mode & 0o777).toBe(
      0o600,
    );
    expect((await stat(join(outputPath, "selection.json"))).mode & 0o777).toBe(
      0o600,
    );
  });

  test("repairs one invalid response in the same Pi session", async () => {
    const workspace = await createWorkspace();
    const outputPath = join(workspace, "trend-run");
    const snapshot = trendingSnapshot();
    const runtime = new FakeTrendRuntime([
      selectionResponse(snapshot.entries.slice(0, 9)),
      selectionResponse(snapshot.entries.slice(1, 11)),
    ]);

    const result = await runTrendSelection(
      {
        output_path: outputPath,
        allow_remote_model: true,
      },
      {
        collect_trending: async () => ({
          snapshots: [snapshot],
          failures: [],
        }),
        create_runtime: () => runtime,
        now: fixedClock("2026-08-04T01:02:03Z", "2026-08-04T01:02:04Z"),
      },
    );

    expect(runtime.started_inputs).toHaveLength(1);
    expect(runtime.prompts).toHaveLength(2);
    expect(runtime.prompts[1]).toContain(
      "selected_repositories must contain exactly 10 items",
    );
    expect(runtime.disposed).toBe(1);
    expect(result.selection.agent).toMatchObject({
      turn_count: 2,
      usage: { input_tokens: 6, output_tokens: 4 },
    });
    expect(
      result.selection.selected_repositories.map(
        (repository) => repository.repository_full_name,
      ),
    ).toEqual(snapshot.entries.slice(1, 11).map(repositoryName));
  });

  test("fails closed when the correction still selects an unknown candidate", async () => {
    const workspace = await createWorkspace();
    const outputPath = join(workspace, "trend-run");
    const snapshot = trendingSnapshot();
    const duplicate = [snapshot.entries[0]!, ...snapshot.entries.slice(0, 9)];
    const unknown = snapshot.entries
      .slice(0, 10)
      .map((entry) => ({ ...entry }));
    unknown[9] = {
      ...unknown[9]!,
      repository_full_name: "unknown/not-a-candidate",
    };
    const runtime = new FakeTrendRuntime([
      selectionResponse(duplicate),
      selectionResponse(unknown),
    ]);

    await expect(
      runTrendSelection(
        { output_path: outputPath, allow_remote_model: true },
        {
          collect_trending: async () => ({
            snapshots: [snapshot],
            failures: [],
          }),
          create_runtime: () => runtime,
          now: fixedClock("2026-08-04T01:02:03Z"),
        },
      ),
    ).rejects.toMatchObject({
      exit_code: ExitCode.validation,
      message: expect.stringContaining("is not a candidate"),
    } satisfies Partial<PaperbotError>);
    expect(runtime.prompts).toHaveLength(2);
    expect(runtime.disposed).toBe(1);
    expect(await Bun.file(join(outputPath, "snapshot.json")).exists()).toBe(
      true,
    );
    expect(await Bun.file(join(outputPath, "selection.json")).exists()).toBe(
      false,
    );
  });

  test("retains a small source snapshot without starting Pi", async () => {
    const workspace = await createWorkspace();
    const outputPath = join(workspace, "trend-run");
    const snapshot = trendingSnapshot(9);
    let runtimeCreated = false;

    await expect(
      runTrendSelection(
        { output_path: outputPath, allow_remote_model: true },
        {
          collect_trending: async () => ({
            snapshots: [snapshot],
            failures: [],
          }),
          create_runtime: () => {
            runtimeCreated = true;
            return new FakeTrendRuntime([]);
          },
          now: fixedClock("2026-08-04T01:02:03Z"),
        },
      ),
    ).rejects.toMatchObject({
      exit_code: ExitCode.remote,
      message:
        "GitHub Trending returned 9 candidates; at least 10 are required",
    } satisfies Partial<PaperbotError>);
    expect(runtimeCreated).toBe(false);
    expect(await readJson(join(outputPath, "snapshot.json"))).toEqual(snapshot);
  });
});

test("rejects control characters in model-authored selection reasons", () => {
  const entries = trendingSnapshot().entries;
  const response = {
    selected_repositories: entries.slice(0, 10).map((entry, index) => ({
      repository_full_name: entry.repository_full_name,
      reason:
        index === 0
          ? "A reason with\na hidden line break."
          : `Candidate ${index + 1} is interesting.`,
    })),
  };

  expect(() =>
    parseTrendSelectionResponse(JSON.stringify(response), entries),
  ).toThrow("must not contain control characters");
});

class FakeTrendRuntime implements TrendSelectionRuntime {
  readonly provider = "fake-pi";
  readonly model = "deepseek-v4-flash";
  readonly prompts: string[] = [];
  readonly started_inputs: Array<{
    role: "trend_selection";
    run_path: string;
  }> = [];
  disposed = 0;

  constructor(private readonly responses: Array<string | Error>) {}

  async startSession(input: { role: "trend_selection"; run_path: string }) {
    this.started_inputs.push(input);
    return {
      complete: async ({ prompt }: { prompt: string }) => {
        this.prompts.push(prompt);
        const response = this.responses.shift();
        if (response === undefined) {
          throw new Error("unexpected trend-selection model call");
        }
        if (response instanceof Error) {
          throw response;
        }
        return {
          final_text: response,
          model: this.model,
          usage: { input_tokens: 3, output_tokens: 2 },
        } satisfies ModelCompletion;
      },
      snapshot: () => ({ session_id: "fake-trend-selection" }),
      dispose: () => {
        this.disposed += 1;
      },
    };
  }
}

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "paperbot-trends-"));
  workspaces.push(workspace);
  return workspace;
}

function trendingSnapshot(entryCount = 12): TrendingSnapshot {
  return {
    snapshot_date: "2026-08-04",
    captured_at: "2026-08-04T01:02:03Z",
    period: "daily",
    language: null,
    spoken_language: null,
    source_kind: "direct_fetch",
    source_url: "https://github.com/trending?since=daily",
    source_revision: `sha256:${"a".repeat(64)}`,
    entries: Array.from({ length: entryCount }, (_, index) => ({
      repository_full_name: `example/repo-${index + 1}`,
      repository_node_id: null,
      description: `Candidate ${index + 1} description`,
      primary_language: index % 2 === 0 ? "Rust" : "TypeScript",
      stars: 1_000 + index,
      forks: 100 + index,
      stars_in_period: 50 + index,
    })),
  };
}

function selectionResponse(entries: TrendingEntry[]): string {
  return JSON.stringify({
    selected_repositories: entries.map((entry, index) => ({
      repository_full_name: entry.repository_full_name,
      reason: `Candidate ${index + 1} merits deeper product-paper research.`,
    })),
  });
}

function repositoryName(entry: TrendingEntry): string {
  return entry.repository_full_name;
}

function fixedClock(...values: string[]): () => Date {
  const dates = values.map((value) => new Date(value));
  return () => {
    const value = dates.shift();
    if (value === undefined) {
      throw new Error("test clock was exhausted");
    }
    return value;
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
