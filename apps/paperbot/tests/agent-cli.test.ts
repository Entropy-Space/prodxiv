import { expect, test } from "bun:test";

import { parseArguments } from "../src/arguments.ts";
import type { AgentBatchResult } from "../src/agent/batch.ts";
import type { AgentRunResult } from "../src/agent/types.ts";
import type { TrendSelectionRunResult } from "../src/agent/trend-selection.ts";
import { run } from "../src/cli.ts";

const agentResult: AgentRunResult = {
  run_path: "/tmp/paperbot-openwork",
  state: "needs_author_review",
  validation: {
    valid: true,
    diagnostics: 0,
  },
  questions: {
    pending: 0,
    round: 0,
  },
  source: {
    resolved_revision: "abc123",
    selected_file_count: 12,
  },
};

const batchResult: AgentBatchResult = {
  output_path: "/tmp/paperbot-batch",
  report: {
    schema_version: "1",
    started_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    input: {
      input_path: "/tmp/projects.json",
      allow_remote_model: true,
      concurrency: 2,
      authors: ["Research Team"],
      status: "public_beta",
      model: "deepseek-v4-flash",
    },
    projects: [],
    summary: { total: 2, pending: 0, running: 0, succeeded: 2, failed: 0 },
  },
};

const trendSelectionResult: TrendSelectionRunResult = {
  output_path: "/tmp/paperbot-trending",
  snapshot_path: "/tmp/paperbot-trending/snapshot.json",
  selection_path: "/tmp/paperbot-trending/selection.json",
  selection: {
    schema_version: "2",
    generated_at: "2026-08-04T01:02:04Z",
    selection_policy: "product_paper_interest_v1",
    snapshot: {
      schema_version: "1",
      snapshot_date: "2026-08-04",
      period: "daily",
      language: "any",
      spoken_language: null,
      scope_count: 1,
      candidate_count: 12,
      available_languages: [],
      scopes: [
        {
          snapshot_date: "2026-08-04",
          captured_at: "2026-08-04T01:02:03Z",
          period: "daily",
          language: "any",
          spoken_language: null,
          source_kind: "direct_fetch",
          source_url: "https://github.com/trending?since=daily",
          source_revision: `sha256:${"a".repeat(64)}`,
          entry_count: 12,
        },
      ],
    },
    agent: {
      provider: "pi",
      model: "deepseek-v4-flash",
      session_id: "trend-session",
      session_artifact: "sessions/trend_selection/trend-session.jsonl",
      session_artifact_sha256: "b".repeat(64),
      turn_count: 1,
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    selected_repositories: Array.from({ length: 10 }, (_, index) => ({
      rank: index + 1,
      candidate_rank: index + 1,
      repository_full_name: `example/repo-${index + 1}`,
      repository_node_id: null,
      description: `Candidate ${index + 1}`,
      primary_language: index % 2 === 0 ? "Rust" : "TypeScript",
      stars: 1_000 + index,
      forks: 100 + index,
      repository_url: `https://github.com/example/repo-${index + 1}`,
      source_appearances: [
        {
          scope_language: "any",
          source_rank: index + 2,
          stars_in_period: 50 + index,
        },
      ],
      reason: `Candidate ${index + 1} merits deeper research.`,
    })),
  },
};

test("parses a complete Pi agent run without inferring author metadata", () => {
  expect(
    parseArguments([
      "agent",
      "run",
      "https://github.com/different-ai/openwork",
      "--output",
      "runs/openwork",
      "--author",
      "Ada Lovelace",
      "--author=Lin Example",
      "--status=public_beta",
      "--allow-remote-model",
      "--title",
      "OpenWork research draft",
      "--product-name",
      "OpenWork",
      "--product-url=https://openwork.example",
      "--repository-url",
      "https://github.com/different-ai/openwork",
      "--source",
      "https://openwork.example/docs",
      "--source=https://github.com/different-ai/openwork",
      "--ref",
      "v1.2.3",
      "--model=deepseek-v4-flash",
      "--format=json",
    ]),
  ).toEqual({
    command: "agent",
    action: "run",
    repository: "https://github.com/different-ai/openwork",
    output_path: "runs/openwork",
    allow_remote_model: true,
    metadata: {
      title: "OpenWork research draft",
      product_name: "OpenWork",
      authors: ["Ada Lovelace", "Lin Example"],
      status: "public_beta",
      product_url: "https://openwork.example",
      repository_url: "https://github.com/different-ai/openwork",
    },
    external_sources: [
      "https://openwork.example/docs",
      "https://github.com/different-ai/openwork",
    ],
    ref: "v1.2.3",
    model: "deepseek-v4-flash",
    format: "json",
  });
});

test("uses a repository identifier only as an explicit draft default", () => {
  expect(
    parseArguments([
      "agent",
      "run",
      "https://github.com/cjpais/Handy.git",
      "--output",
      "runs/handy",
      "--author",
      "Research Team",
      "--status",
      "concept",
      "--allow-remote-model",
    ]),
  ).toEqual(
    expect.objectContaining({
      metadata: {
        title: "Handy research draft",
        product_name: "Handy",
        authors: ["Research Team"],
        status: "concept",
      },
    }),
  );
});

test("parses an explicitly consented agent resume", () => {
  expect(
    parseArguments([
      "agent",
      "resume",
      "runs/openwork",
      "--answers=answers.md",
      "--model",
      "deepseek-v4-flash",
      "--allow-remote-model",
      "--format",
      "json",
    ]),
  ).toEqual({
    command: "agent",
    action: "resume",
    run_path: "runs/openwork",
    answers_path: "answers.md",
    allow_remote_model: true,
    model: "deepseek-v4-flash",
    format: "json",
  });
});

test("parses a consented agent batch with manifest defaults", () => {
  expect(
    parseArguments([
      "agent",
      "batch",
      "projects.json",
      "--output",
      "runs",
      "--author",
      "Research Team",
      "--status=public_beta",
      "--model",
      "deepseek-v4-flash",
      "--concurrency=2",
      "--allow-remote-model",
      "--format=json",
    ]),
  ).toEqual({
    command: "agent",
    action: "batch",
    input_path: "projects.json",
    output_path: "runs",
    allow_remote_model: true,
    authors: ["Research Team"],
    status: "public_beta",
    model: "deepseek-v4-flash",
    concurrency: 2,
    format: "json",
  });
});

test("parses a consented daily trend selection", () => {
  expect(
    parseArguments([
      "agent",
      "select-trending",
      "--output",
      "runs/trending-2026-08-04",
      "--api-url",
      "https://api.prodxiv.example",
      "--model=deepseek-v4-flash",
      "--allow-remote-model",
      "--format=json",
    ]),
  ).toEqual({
    command: "agent",
    action: "select-trending",
    output_path: "runs/trending-2026-08-04",
    allow_remote_model: true,
    api_url: "https://api.prodxiv.example",
    model: "deepseek-v4-flash",
    format: "json",
  });
});

test("parses an offline daily trend selection snapshot", () => {
  expect(
    parseArguments([
      "agent",
      "select-trending",
      "--output=runs/trending-2026-08-03",
      "--snapshot",
      "snapshots/2026-08-03.json",
      "--allow-remote-model",
    ]),
  ).toEqual({
    command: "agent",
    action: "select-trending",
    output_path: "runs/trending-2026-08-03",
    allow_remote_model: true,
    snapshot_path: "snapshots/2026-08-03.json",
    format: "text",
  });
});

test("rejects conflicting trend snapshot inputs", () => {
  expect(() =>
    parseArguments([
      "agent",
      "select-trending",
      "--output",
      "runs/trending",
      "--snapshot",
      "snapshot.json",
      "--api-url",
      "https://api.prodxiv.example",
      "--allow-remote-model",
    ]),
  ).toThrow(
    "agent select-trending accepts either --snapshot or --api-url, not both",
  );
});

test("requires explicit remote-model consent before loading the agent runtime", async () => {
  const stderr: string[] = [];

  const exitCode = await run(
    [
      "agent",
      "run",
      "https://github.com/different-ai/openwork",
      "--output",
      "runs/openwork",
      "--author",
      "Research Team",
      "--status",
      "concept",
    ],
    {
      stdout: () => {},
      stderr: (message) => stderr.push(message),
    },
  );

  expect(exitCode).toBe(2);
  expect(stderr).toEqual([
    "paperbot: agent run requires --allow-remote-model before source content is sent to a model",
  ]);
});

test("requires explicit remote-model consent before starting a batch", async () => {
  const stderr: string[] = [];

  const exitCode = await run(
    ["agent", "batch", "projects.json", "--output", "runs"],
    {
      stdout: () => {},
      stderr: (message) => stderr.push(message),
    },
  );

  expect(exitCode).toBe(2);
  expect(stderr).toEqual([
    "paperbot: agent batch requires --allow-remote-model before source content is sent to a model",
  ]);
});

test("requires explicit remote-model consent before selecting trends", async () => {
  const stderr: string[] = [];

  const exitCode = await run(
    ["agent", "select-trending", "--output", "runs/trending"],
    {
      stdout: () => {},
      stderr: (message) => stderr.push(message),
    },
  );

  expect(exitCode).toBe(2);
  expect(stderr).toEqual([
    "paperbot: agent select-trending requires --allow-remote-model before the public trend snapshot is sent to a model",
  ]);
});

test("writes only the agent result to stdout in JSON mode", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let receivedRepository: string | undefined;

  const exitCode = await run(
    [
      "agent",
      "run",
      "https://github.com/different-ai/openwork",
      "--output",
      "runs/openwork",
      "--author",
      "Research Team",
      "--status",
      "concept",
      "--allow-remote-model",
      "--format",
      "json",
    ],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
    {
      run_agent: async (input) => {
        receivedRepository = input.repository;
        expect(input.metadata).toEqual({
          title: "openwork research draft",
          product_name: "openwork",
          authors: ["Research Team"],
          status: "concept",
        });
        return agentResult;
      },
    },
  );

  expect(exitCode).toBe(0);
  expect(receivedRepository).toBe("https://github.com/different-ai/openwork");
  expect(stdout).toEqual([JSON.stringify(agentResult, null, 2)]);
  expect(stderr).toEqual([
    "paperbot: agent run completed with 0 validation diagnostics",
  ]);
});

test("reports a validated author-question checkpoint as a successful run", async () => {
  const stdout: string[] = [];
  const awaitingResult: AgentRunResult = {
    ...agentResult,
    state: "awaiting_author",
    questions: { pending: 3, round: 1 },
  };

  const exitCode = await run(
    [
      "agent",
      "run",
      "https://github.com/different-ai/openwork",
      "--output",
      "runs/openwork",
      "--author",
      "Research Team",
      "--status",
      "concept",
      "--allow-remote-model",
    ],
    { stdout: (message) => stdout.push(message), stderr: () => {} },
    { run_agent: async () => awaitingResult },
  );

  expect(exitCode).toBe(0);
  expect(stdout[0]).toContain("waiting for author answers");
  expect(stdout[0]).toContain("Author questions: 3 pending (round 1)");
});

test("dispatches an agent resume without a network runtime in tests", async () => {
  const stdout: string[] = [];
  let receivedAnswersPath: string | undefined;

  const exitCode = await run(
    [
      "agent",
      "resume",
      "runs/openwork",
      "--answers",
      "answers.md",
      "--allow-remote-model",
    ],
    {
      stdout: (message) => stdout.push(message),
      stderr: () => {},
    },
    {
      resume_agent: async (input) => {
        receivedAnswersPath = input.answers_path;
        return agentResult;
      },
    },
  );

  expect(exitCode).toBe(0);
  expect(receivedAnswersPath).toBe("answers.md");
  expect(stdout[0]).toContain("Paperbot agent paper revision prepared");
  expect(stdout[0]).toContain("Author questions: 0 pending (round 0)");
  expect(stdout[0]).toContain("Publication: not attempted");
});

test("writes only the selection artifact to stdout in JSON mode", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let receivedOutputPath: string | undefined;

  const exitCode = await run(
    [
      "agent",
      "select-trending",
      "--output",
      "runs/trending",
      "--allow-remote-model",
      "--model",
      "deepseek-v4-flash",
      "--snapshot",
      "snapshots/2026-08-03.json",
      "--format",
      "json",
    ],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
    {
      run_trend_selection: async (input) => {
        receivedOutputPath = input.output_path;
        expect(input).toEqual({
          output_path: "runs/trending",
          allow_remote_model: true,
          snapshot_path: "snapshots/2026-08-03.json",
          model: "deepseek-v4-flash",
        });
        return trendSelectionResult;
      },
    },
  );

  expect(exitCode).toBe(0);
  expect(receivedOutputPath).toBe("runs/trending");
  expect(stdout).toEqual([
    JSON.stringify(trendSelectionResult.selection, null, 2),
  ]);
  expect(stderr).toEqual([
    "paperbot: selected 10 repositories in /tmp/paperbot-trending/selection.json",
  ]);
});

test("dispatches an agent batch and uses a nonzero result for failed projects", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let receivedConcurrency: number | undefined;

  const successExitCode = await run(
    [
      "agent",
      "batch",
      "projects.json",
      "--output",
      "runs",
      "--author",
      "Research Team",
      "--status",
      "public_beta",
      "--concurrency",
      "2",
      "--allow-remote-model",
      "--format",
      "json",
    ],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
    {
      run_agent_batch: async (input) => {
        receivedConcurrency = input.concurrency;
        return batchResult;
      },
    },
  );

  expect(successExitCode).toBe(0);
  expect(receivedConcurrency).toBe(2);
  expect(stdout).toEqual([JSON.stringify(batchResult, null, 2)]);
  expect(stderr).toEqual([
    "paperbot: agent batch completed with 2 succeeded and 0 failed projects",
  ]);

  const partialFailure: AgentBatchResult = {
    ...batchResult,
    report: {
      ...batchResult.report,
      summary: { ...batchResult.report.summary, succeeded: 1, failed: 1 },
    },
  };
  const failureExitCode = await run(
    [
      "agent",
      "batch",
      "projects.json",
      "--output",
      "runs",
      "--allow-remote-model",
    ],
    { stdout: () => {}, stderr: () => {} },
    { run_agent_batch: async () => partialFailure },
  );
  expect(failureExitCode).toBe(8);
});
