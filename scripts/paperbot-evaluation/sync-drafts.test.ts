import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProdxivApiError } from "../../packages/api-client/src/client.ts";
import { promoteDrafts, submitBatchDrafts } from "./sync-drafts.ts";

test("publishes approved drafts and auto-publishes pending bot drafts", async () => {
  const publishedRequests: string[] = [];
  const report = await promoteDrafts({
    async listDrafts(input) {
      if (input.review_status === "pending_review") {
        expect(input.owner_kind).toBe("bot");
        return {
          drafts: [pendingBotDraft("00000000-0000-4000-8000-000000000003", 1)],
        };
      }
      return {
        drafts: [
          approvedDraft("00000000-0000-4000-8000-000000000001", 2),
          approvedDraft("00000000-0000-4000-8000-000000000002", 3),
        ],
      };
    },
    async publishDraft(paperUuid, input) {
      publishedRequests.push(`${paperUuid}:${input.expected_revision}`);
      if (paperUuid.endsWith("2")) {
        throw new ProdxivApiError(
          409,
          "draft.revision_conflict",
          "draft changed",
        );
      }
      return {
        paper: { paper_id: "prodxiv:2608.000001", version: 1 },
        replayed: false,
      };
    },
    async approveAndPublishDraft(paperUuid, input) {
      publishedRequests.push(
        `automatic:${paperUuid}:${input.expected_revision}`,
      );
      return {
        paper: { paper_id: "prodxiv:2608.000002", version: 1 },
        replayed: false,
      };
    },
    async createDraft() {
      throw new Error("promotion must not create drafts");
    },
    async rejectDraft() {
      throw new Error("promotion must not reject drafts");
    },
  });

  expect(publishedRequests).toEqual([
    "00000000-0000-4000-8000-000000000001:2",
    "00000000-0000-4000-8000-000000000002:3",
    "automatic:00000000-0000-4000-8000-000000000003:1",
  ]);
  expect(report.published).toHaveLength(2);
  expect(report.pending_bot_count).toBe(1);
  expect(report.published.map((published) => published.approval_kind)).toEqual([
    "human",
    "automatic",
  ]);
  expect(report.skipped).toEqual([
    {
      paper_uuid: "00000000-0000-4000-8000-000000000002",
      draft_revision: 3,
      reason: "draft_changed",
    },
  ]);
  expect(report.failed).toEqual([]);
});

test("rejects an unpublishable pending bot draft and preserves diagnostics", async () => {
  const paperUuid = "00000000-0000-4000-8000-000000000004";
  const rejected: string[] = [];
  const diagnostic = {
    severity: "error" as const,
    code: "submission.license_required",
    path: "metadata.license",
    message: "submitted papers require a license",
  };
  const report = await promoteDrafts({
    async listDrafts(input) {
      return {
        drafts:
          input.review_status === "pending_review"
            ? [pendingBotDraft(paperUuid, 1)]
            : [],
      };
    },
    async publishDraft() {
      throw new Error("no approved draft should be published");
    },
    async approveAndPublishDraft() {
      throw new ProdxivApiError(
        422,
        "paper.invalid",
        "paper submission failed validation",
        [diagnostic],
      );
    },
    async createDraft() {
      throw new Error("promotion must not create drafts");
    },
    async rejectDraft(rejectedUuid, input) {
      rejected.push(
        `${rejectedUuid}:${input.expected_revision}:${input.reason}`,
      );
      return { paper_uuid: rejectedUuid, revision: input.expected_revision };
    },
  });

  expect(rejected).toEqual([
    `${paperUuid}:1:Automatic publication validation failed; retained for audit.`,
  ]);
  expect(report.rejected).toEqual([
    {
      paper_uuid: paperUuid,
      draft_revision: 1,
      reason: "publication_invalid",
      error_code: "paper.invalid",
      message: "paper submission failed validation",
      diagnostics: [diagnostic],
    },
  ]);
  expect(report.failed).toEqual([]);
});

test("keeps an invalid author-approved draft for correction", async () => {
  const paperUuid = "00000000-0000-4000-8000-000000000005";
  const diagnostic = {
    severity: "error" as const,
    code: "submission.license_required",
    path: "metadata.license",
    message: "submitted papers require a license",
  };
  const report = await promoteDrafts({
    async listDrafts(input) {
      return {
        drafts:
          input.review_status === "approved"
            ? [approvedDraft(paperUuid, 2)]
            : [],
      };
    },
    async publishDraft() {
      throw new ProdxivApiError(
        422,
        "paper.invalid",
        "paper submission failed validation",
        [diagnostic],
      );
    },
    async approveAndPublishDraft() {
      throw new Error("no pending bot draft should be published");
    },
    async createDraft() {
      throw new Error("promotion must not create drafts");
    },
    async rejectDraft() {
      throw new Error("approved drafts must remain available for correction");
    },
  });

  expect(report.rejected).toEqual([]);
  expect(report.failed).toEqual([
    {
      paper_uuid: paperUuid,
      draft_revision: 2,
      error_code: "paper.invalid",
      message: "paper submission failed validation",
      diagnostics: [diagnostic],
    },
  ]);
});

test("submits complete batches only after verifying their final ZIPs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "paperbot-draft-sync-"));
  const checkpoints = join(workspace, "checkpoints");
  await mkdir(checkpoints);
  const projects = [];
  for (let index = 1; index <= 3; index += 1) {
    const outputPath = join(workspace, `example__project-${index}`);
    await mkdir(outputPath);
    await writeFile(join(outputPath, "paper.md"), submissionReadyPaper(index));
    const archiveName = `2026-08-17_project-${index}_${runId(index)}_final.zip`;
    const archive = Buffer.from(`archive-${index}`);
    await writeFile(join(checkpoints, archiveName), archive);
    projects.push({
      project_index: index,
      repository_url: `https://github.com/example/project-${index}`,
      output_path: outputPath,
      state: "succeeded",
      result: {
        run_id: runId(index),
        run_path: outputPath,
        state: "needs_author_review",
        checkpoint: {
          reason: "needs_author_review",
          archive: `../checkpoints/${archiveName}`,
          archive_sha256: sha256(archive),
        },
      },
    });
  }
  const batchPath = join(workspace, "batch.json");
  await writeFile(batchPath, JSON.stringify({ schema_version: "2", projects }));
  const submittedKeys: string[] = [];
  const pendingDrafts = Array.from({ length: 5 }, (_, index) => ({
    paper_uuid: `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    revision: 1,
    owner_kind: "bot" as const,
    review: {},
  }));
  const report = await submitBatchDrafts(batchPath, 3, {
    async listDrafts(input) {
      if (input.review_status !== "pending_review") {
        throw new Error("submission may list only pending drafts");
      }
      return { drafts: [...pendingDrafts] };
    },
    async publishDraft() {
      throw new Error("submission must not publish drafts");
    },
    async approveAndPublishDraft() {
      throw new Error("submission must not auto-publish drafts");
    },
    async createDraft(input) {
      submittedKeys.push(input.idempotency_key);
      const draft = {
        paper_uuid: `00000000-0000-4000-8000-00000000000${submittedKeys.length}`,
        revision: 1,
      };
      pendingDrafts.unshift({ ...draft, owner_kind: "bot", review: {} });
      return draft;
    },
    async rejectDraft(paperUuid) {
      const index = pendingDrafts.findIndex(
        (draft) => draft.paper_uuid === paperUuid,
      );
      if (index === -1) {
        throw new Error("rotated draft should exist");
      }
      const [draft] = pendingDrafts.splice(index, 1);
      if (draft === undefined) {
        throw new Error("rotated draft should be removable");
      }
      return draft;
    },
  });

  expect(report.failed).toEqual([]);
  expect(report).toMatchObject({
    schema_version: "2",
    expected_count: 3,
    successful_run_count: 3,
    shortfall_count: 0,
    batch_failed: [],
  });
  expect(report.submitted).toHaveLength(3);
  expect(report.rotated).toHaveLength(3);
  expect(pendingDrafts).toHaveLength(5);
  expect(submittedKeys).toEqual([
    `paperbot-draft:${runId(1)}`,
    `paperbot-draft:${runId(2)}`,
    `paperbot-draft:${runId(3)}`,
  ]);
  expect(
    report.submitted.every((submission) =>
      submission.archive.endsWith("_final.zip"),
    ),
  ).toBe(true);
});

test("submits successful projects and records an incomplete batch", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "paperbot-partial-sync-"));
  const checkpoints = join(workspace, "checkpoints");
  await mkdir(checkpoints);
  const projects = [];
  for (let index = 1; index <= 2; index += 1) {
    const outputPath = join(workspace, `example__project-${index}`);
    await mkdir(outputPath);
    await writeFile(join(outputPath, "paper.md"), submissionReadyPaper(index));
    const archiveName = `2026-08-21_project-${index}_${runId(index)}_final.zip`;
    const archive = Buffer.from(`archive-${index}`);
    await writeFile(join(checkpoints, archiveName), archive);
    projects.push({
      project_index: index,
      repository_url: `https://github.com/example/project-${index}`,
      output_path: outputPath,
      state: "succeeded",
      result: {
        run_id: runId(index),
        run_path: outputPath,
        state: "needs_author_review",
        checkpoint: {
          reason: "needs_author_review",
          archive: `../checkpoints/${archiveName}`,
          archive_sha256: sha256(archive),
        },
      },
    });
  }
  projects.push({
    project_index: 3,
    repository_url: "https://github.com/example/failed-project",
    output_path: join(workspace, "example__failed-project"),
    state: "failed",
  });
  const batchPath = join(workspace, "batch.json");
  await writeFile(batchPath, JSON.stringify({ schema_version: "2", projects }));
  const submittedKeys: string[] = [];

  const report = await submitBatchDrafts(batchPath, 3, {
    async listDrafts() {
      return { drafts: [] };
    },
    async publishDraft() {
      throw new Error("submission must not publish drafts");
    },
    async approveAndPublishDraft() {
      throw new Error("submission must not auto-publish drafts");
    },
    async createDraft(input) {
      submittedKeys.push(input.idempotency_key);
      return {
        paper_uuid: `00000000-0000-4000-8000-00000000000${submittedKeys.length}`,
        revision: 1,
      };
    },
    async rejectDraft() {
      throw new Error("an empty pending queue must not rotate drafts");
    },
  });

  expect(report).toMatchObject({
    schema_version: "2",
    expected_count: 3,
    successful_run_count: 2,
    shortfall_count: 1,
    batch_failed: [
      {
        project_index: 3,
        repository_url: "https://github.com/example/failed-project",
        state: "failed",
      },
    ],
    failed: [],
  });
  expect(report.submitted).toHaveLength(2);
  expect(submittedKeys).toEqual([
    `paperbot-draft:${runId(1)}`,
    `paperbot-draft:${runId(2)}`,
  ]);
});

test("does not upload an auto draft that fails submission validation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "paperbot-invalid-sync-"));
  const checkpoints = join(workspace, "checkpoints");
  const outputPath = join(workspace, "example__project-1");
  await mkdir(checkpoints);
  await mkdir(outputPath);
  await writeFile(
    join(outputPath, "paper.md"),
    submissionReadyPaper(1).replace('license: "CC BY 4.0"\n', ""),
  );
  const archiveName = `2026-08-28_project-1_${runId(1)}_final.zip`;
  const archive = Buffer.from("archive-1");
  await writeFile(join(checkpoints, archiveName), archive);
  const batchPath = join(workspace, "batch.json");
  await writeFile(
    batchPath,
    JSON.stringify({
      schema_version: "2",
      projects: [
        {
          project_index: 1,
          repository_url: "https://github.com/example/project-1",
          output_path: outputPath,
          state: "succeeded",
          result: {
            run_id: runId(1),
            run_path: outputPath,
            state: "needs_author_review",
            checkpoint: {
              reason: "needs_author_review",
              archive: `../checkpoints/${archiveName}`,
              archive_sha256: sha256(archive),
            },
          },
        },
      ],
    }),
  );
  let createCalled = false;

  const report = await submitBatchDrafts(batchPath, 1, {
    async listDrafts() {
      return { drafts: [] };
    },
    async publishDraft() {
      throw new Error("submission must not publish drafts");
    },
    async approveAndPublishDraft() {
      throw new Error("submission must not auto-publish drafts");
    },
    async createDraft() {
      createCalled = true;
      throw new Error("invalid papers must not be uploaded");
    },
    async rejectDraft() {
      throw new Error("an empty pending queue must not rotate drafts");
    },
  });

  expect(createCalled).toBe(false);
  expect(report.submitted).toEqual([]);
  expect(report.failed).toEqual([
    {
      project_index: 1,
      repository_url: "https://github.com/example/project-1",
      message: expect.stringContaining(
        "submission.license_required metadata.license",
      ),
    },
  ]);
});

function approvedDraft(paperUuid: string, revision: number) {
  return {
    paper_uuid: paperUuid,
    revision,
    owner_kind: "bot" as const,
    review: { reviewed_revision: revision },
  };
}

function pendingBotDraft(paperUuid: string, revision: number) {
  return {
    paper_uuid: paperUuid,
    revision,
    owner_kind: "bot" as const,
    review: {},
  };
}

function submissionReadyPaper(index: number): string {
  return `---
schema_version: "2"
title: "Paper ${index}"
product_name: "Product ${index}"
scope:
  kind: product
summary: "A submission-ready Paperbot evaluation fixture."
authors:
  - kind: "organization"
    name: "Example"
writers:
  - kind: "agent"
    name: "paperbot"
    model: "fixture-model"
status:
  value: "concept"
  determination: "declared"
  confidence: "high"
topics:
  - "developer_tools"
license: "CC BY 4.0"
---

# Summary

This fixture is complete.

# Background

It exercises scheduled draft submission.

# Motivation

It keeps the submission boundary covered.

# Related Work

No comparison claims are made.

# Core Features

The fixture contains every required section.

# Insights and Lessons

Submission validation must happen before a remote write.

# Limitations

This is only a test fixture.

# References

No external references are required by this fixture.
`;
}

function runId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function sha256(value: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
