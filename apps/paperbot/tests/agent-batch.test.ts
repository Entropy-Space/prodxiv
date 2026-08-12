import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_AGENT_BATCH_CONCURRENCY,
  runAgentBatch,
} from "../src/agent/batch.ts";
import type { AgentRunOptions } from "../src/agent/runner.ts";
import type { AgentRunResult } from "../src/agent/types.ts";

const createdWorkspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdWorkspaces
      .splice(0)
      .map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
});

describe("runAgentBatch", () => {
  test("merges explicit batch defaults with project metadata and writes an ordered report", async () => {
    const workspace = await createWorkspace();
    const inputPath = await writeManifest(workspace, {
      schema_version: "1",
      projects: [
        {
          repository_url: "https://github.com/Example/first-project.git",
          external_sources: ["https://docs.example.test/first"],
          ref: "v1.2.0",
        },
        {
          repository_url: "https://github.com/example/second_project",
          title: "Second Project Paper",
          product_name: "Second Project",
          product_url: "https://second.example.test/",
          authors: ["Project Author"],
          status: "launched",
        },
      ],
    });
    const calls: AgentRunOptions[] = [];
    const outputPath = join(workspace, "runs");

    const result = await runAgentBatch(
      {
        input_path: inputPath,
        output_path: outputPath,
        allow_remote_model: true,
        authors: ["Batch Author"],
        status: "concept",
        model: "deepseek-v4-flash",
      },
      {
        run_agent: async (options) => {
          calls.push(options);
          return successfulRun(options.output_path);
        },
        now: () => new Date("2026-08-01T00:00:00.000Z"),
      },
    );

    expect(calls).toEqual([
      {
        repository: "https://github.com/Example/first-project",
        output_path: join(outputPath, "example__first-project"),
        allow_remote_model: true,
        mode: "auto",
        feedback: "none",
        metadata: {
          title: "first project research draft",
          product_name: "first project",
          authors: ["Batch Author"],
          status: "concept",
          repository_url: "https://github.com/Example/first-project",
        },
        external_sources: ["https://docs.example.test/first"],
        ref: "v1.2.0",
        model: "deepseek-v4-flash",
      },
      {
        repository: "https://github.com/example/second_project",
        output_path: join(outputPath, "example__second_project"),
        allow_remote_model: true,
        mode: "auto",
        feedback: "none",
        metadata: {
          title: "Second Project Paper",
          product_name: "Second Project",
          authors: ["Project Author"],
          status: "launched",
          product_url: "https://second.example.test/",
          repository_url: "https://github.com/example/second_project",
        },
        external_sources: [],
        model: "deepseek-v4-flash",
      },
    ]);
    expect(result.output_path).toBe(outputPath);
    expect(result.report.summary).toEqual({
      total: 2,
      pending: 0,
      running: 0,
      succeeded: 2,
      failed: 0,
    });
    expect(result.report.projects.map((project) => project.state)).toEqual([
      "succeeded",
      "succeeded",
    ]);

    const report = JSON.parse(
      await readFile(join(outputPath, "batch.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(report).toMatchObject({
      schema_version: "2",
      input: {
        allow_remote_model: true,
        mode: "auto",
        authors: ["Batch Author"],
        status: "concept",
        model: "deepseek-v4-flash",
        concurrency: 1,
      },
      summary: { succeeded: 2, failed: 0 },
    });
    expect(JSON.stringify(report)).not.toContain("repositoryUrl");
    expect(JSON.stringify(report)).not.toContain("externalSources");
  });

  test("leaves omitted attribution and status for per-project GitHub inference", async () => {
    const workspace = await createWorkspace();
    const inputPath = await writeManifest(workspace, {
      schema_version: "1",
      projects: [
        {
          repository_url: "https://github.com/example/complete",
          authors: ["Project Author"],
          status: "public_beta",
        },
        {
          repository_url: "https://github.com/example/missing-metadata",
        },
      ],
    });
    const calls: AgentRunOptions[] = [];
    const outputPath = join(workspace, "runs");

    const result = await runAgentBatch(
      {
        input_path: inputPath,
        output_path: outputPath,
        allow_remote_model: true,
      },
      {
        run_agent: async (options) => {
          calls.push(options);
          return successfulRun(options.output_path);
        },
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]?.metadata).toEqual({
      title: "missing metadata research draft",
      product_name: "missing metadata",
      repository_url: "https://github.com/example/missing-metadata",
    });
    expect(result.report.summary).toEqual({
      total: 2,
      pending: 0,
      running: 0,
      succeeded: 2,
      failed: 0,
    });
    expect(result.report.projects[1]).toMatchObject({
      state: "succeeded",
      metadata: {
        repository_url: "https://github.com/example/missing-metadata",
      },
    });
  });

  test("continues after an independent agent failure and keeps report order stable with concurrency", async () => {
    const workspace = await createWorkspace();
    const inputPath = await writeManifest(workspace, {
      schema_version: "1",
      projects: [
        {
          repository_url: "https://github.com/example/fails",
          authors: ["Author"],
          status: "concept",
        },
        {
          repository_url: "https://github.com/example/succeeds",
          authors: ["Author"],
          status: "concept",
        },
      ],
    });

    const result = await runAgentBatch(
      {
        input_path: inputPath,
        output_path: join(workspace, "runs"),
        allow_remote_model: true,
        concurrency: 2,
      },
      {
        run_agent: async (options) => {
          if (options.repository.endsWith("/fails")) {
            throw new Error("source acquisition failed");
          }
          return successfulRun(options.output_path);
        },
      },
    );

    expect(
      result.report.projects.map((project) => project.repository_url),
    ).toEqual([
      "https://github.com/example/fails",
      "https://github.com/example/succeeds",
    ]);
    expect(result.report.projects.map((project) => project.state)).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(result.report.summary).toMatchObject({ succeeded: 1, failed: 1 });
  });

  test("treats a completed but invalid draft as a failed project", async () => {
    const workspace = await createWorkspace();
    const inputPath = await writeManifest(workspace, {
      schema_version: "1",
      projects: [
        {
          repository_url: "https://github.com/example/invalid-draft",
          authors: ["Author"],
          status: "concept",
        },
      ],
    });

    const result = await runAgentBatch(
      {
        input_path: inputPath,
        output_path: join(workspace, "runs"),
        allow_remote_model: true,
        mode: "interactive",
      },
      {
        run_agent: async (options) => ({
          ...successfulRun(options.output_path),
          validation: { valid: false, diagnostics: 3 },
        }),
      },
    );

    expect(result.report.summary).toMatchObject({ succeeded: 0, failed: 1 });
    expect(result.report.projects[0]).toMatchObject({
      state: "failed",
      error: { message: expect.stringContaining("did not pass validation") },
    });
  });

  test("treats an awaiting-author checkpoint as a successful batch project", async () => {
    const workspace = await createWorkspace();
    const inputPath = await writeManifest(workspace, {
      schema_version: "1",
      projects: [
        {
          repository_url: "https://github.com/example/needs-context",
          authors: ["Author"],
          status: "concept",
        },
      ],
    });

    const result = await runAgentBatch(
      {
        input_path: inputPath,
        output_path: join(workspace, "runs"),
        allow_remote_model: true,
        mode: "interactive",
      },
      {
        run_agent: async (options) => ({
          ...successfulRun(options.output_path),
          mode: "interactive",
          feedback: "async",
          state: "awaiting_author",
          questions: { pending: 2, round: 1 },
        }),
      },
    );

    expect(result.report.summary).toMatchObject({ succeeded: 1, failed: 0 });
    expect(result.report.projects[0]).toMatchObject({
      state: "succeeded",
      result: {
        state: "awaiting_author",
        questions: { pending: 2, round: 1 },
      },
    });
  });

  test("rejects an awaiting-author state from default auto batch mode", async () => {
    const workspace = await createWorkspace();
    const inputPath = await writeManifest(workspace, {
      schema_version: "1",
      projects: [
        {
          repository_url: "https://github.com/example/needs-context",
          authors: ["Author"],
          status: "concept",
        },
      ],
    });

    const result = await runAgentBatch(
      {
        input_path: inputPath,
        output_path: join(workspace, "runs"),
        allow_remote_model: true,
      },
      {
        run_agent: async (options) => ({
          ...successfulRun(options.output_path),
          mode: "auto",
          feedback: "none",
          state: "awaiting_author",
          questions: { pending: 2, round: 1 },
        }),
      },
    );

    expect(result.report.summary).toMatchObject({ succeeded: 0, failed: 1 });
    expect(result.report.projects[0]).toMatchObject({
      state: "failed",
      error: { message: expect.stringContaining("unexpected terminal state") },
    });
  });

  test("rejects unsafe manifests and invalid batch options before running a project", async () => {
    const workspace = await createWorkspace();
    const unsafeInputPath = await writeManifest(workspace, {
      schema_version: "1",
      projects: [
        {
          repository_url: "https://github.com/example/project",
          authors: ["Author"],
          status: "concept",
          extra_field: true,
        },
      ],
    });
    const outputPath = join(workspace, "runs");

    await expect(
      runAgentBatch({
        input_path: unsafeInputPath,
        output_path: outputPath,
        allow_remote_model: true,
      }),
    ).rejects.toMatchObject({
      exit_code: 2,
      message: expect.stringContaining("unknown field"),
    });
    await expect(
      readFile(join(outputPath, "batch.json"), "utf8"),
    ).rejects.toThrow();

    const validInputPath = await writeManifest(
      workspace,
      {
        schema_version: "1",
        projects: [
          {
            repository_url: "https://github.com/example/project",
            authors: ["Author"],
            status: "concept",
          },
        ],
      },
      "valid-batch.json",
    );
    await expect(
      runAgentBatch({
        input_path: validInputPath,
        output_path: outputPath,
        allow_remote_model: false,
      }),
    ).rejects.toMatchObject({
      exit_code: 2,
      message: expect.stringContaining("--allow-remote-model"),
    });
    await expect(
      runAgentBatch({
        input_path: validInputPath,
        output_path: outputPath,
        allow_remote_model: true,
        concurrency: MAX_AGENT_BATCH_CONCURRENCY + 1,
      }),
    ).rejects.toMatchObject({
      exit_code: 2,
      message: expect.stringContaining("concurrency"),
    });
  });
});

function successfulRun(outputPath: string): AgentRunResult {
  return {
    run_id: "00000000-0000-4000-8000-000000000001",
    run_path: outputPath,
    mode: "auto",
    feedback: "none",
    state: "needs_author_review",
    validation: { valid: true, diagnostics: 0 },
    questions: { pending: 0, round: 0 },
    source: {
      resolved_revision: "0123456789abcdef0123456789abcdef01234567",
      selected_file_count: 3,
    },
    checkpoint: {
      checkpoint_number: 1,
      reason: "needs_author_review",
      state: "needs_author_review",
      created_at: "2026-08-01T00:00:00.000Z",
      archive:
        "../checkpoints/2026-08-01_run_00000000-0000-4000-8000-000000000001_checkpoint-0001_needs_author_review.zip",
      archive_sha256: "a".repeat(64),
      archive_byte_count: 1024,
      manifest_sha256: "b".repeat(64),
      checkpoint_basis_sha256: "c".repeat(64),
    },
  };
}

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "paperbot-agent-batch-"));
  createdWorkspaces.push(workspace);
  return workspace;
}

async function writeManifest(
  workspace: string,
  manifest: Record<string, unknown>,
  filename = "batch.json",
): Promise<string> {
  const path = join(workspace, filename);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}
