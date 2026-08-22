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

test("submits complete batches only after verifying their final ZIPs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "paperbot-draft-sync-"));
  const checkpoints = join(workspace, "checkpoints");
  await mkdir(checkpoints);
  const projects = [];
  for (let index = 1; index <= 3; index += 1) {
    const outputPath = join(workspace, `example__project-${index}`);
    await mkdir(outputPath);
    await writeFile(join(outputPath, "paper.md"), `# Paper ${index}\n`);
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
    await writeFile(join(outputPath, "paper.md"), `# Paper ${index}\n`);
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

function runId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function sha256(value: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
