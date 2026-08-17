import { readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";

import {
  ProdxivApiClient,
  ProdxivApiError,
  type PublishDraftInput,
} from "../../packages/api-client/src/client.ts";

interface DraftSyncClient {
  listDrafts(input: {
    limit: number;
    review_status: "pending_review" | "approved";
    owner_kind?: "author" | "bot";
  }): Promise<{
    drafts: Array<{
      paper_uuid: string;
      revision: number;
      owner_kind: "author" | "bot";
      review: { reviewed_revision?: number | null };
    }>;
  }>;
  publishDraft(
    paper_uuid: string,
    input: PublishDraftInput,
  ): Promise<{
    paper: { paper_id: string; version: number };
    replayed: boolean;
  }>;
  approveAndPublishDraft(
    paper_uuid: string,
    input: PublishDraftInput,
  ): Promise<{
    paper: { paper_id: string; version: number };
    replayed: boolean;
  }>;
  createDraft(input: {
    source_markdown: string;
    idempotency_key: string;
  }): Promise<{ paper_uuid: string; revision: number }>;
  rejectDraft(
    paper_uuid: string,
    input: { expected_revision: number; reason?: string },
  ): Promise<{ paper_uuid: string; revision: number }>;
}

export interface PromotionReport {
  schema_version: "2";
  approved_count: number;
  pending_bot_count: number;
  published: Array<{
    paper_uuid: string;
    draft_revision: number;
    paper_id: string;
    paper_revision: number;
    replayed: boolean;
    approval_kind: "human" | "automatic";
  }>;
  skipped: Array<{
    paper_uuid: string;
    draft_revision: number;
    reason: "draft_changed" | "ownership_changed";
  }>;
  failed: Array<{
    paper_uuid: string;
    draft_revision: number;
    error_code: string;
    message: string;
  }>;
}

export interface SubmissionReport {
  schema_version: "1";
  expected_count: number;
  submitted: Array<{
    project_index: number;
    repository_url: string;
    run_id: string;
    paper_uuid: string;
    draft_revision: number;
    archive: string;
    archive_sha256: string;
  }>;
  rotated: Array<{
    paper_uuid: string;
    draft_revision: number;
  }>;
  failed: Array<{
    project_index: number;
    repository_url: string;
    message: string;
  }>;
}

export async function promoteDrafts(
  client: DraftSyncClient,
): Promise<PromotionReport> {
  const approved = await client.listDrafts({
    limit: 100,
    review_status: "approved",
  });
  const report: PromotionReport = {
    schema_version: "2",
    approved_count: approved.drafts.length,
    pending_bot_count: 0,
    published: [],
    skipped: [],
    failed: [],
  };
  for (const draft of approved.drafts) {
    const reviewedRevision = draft.review.reviewed_revision;
    if (reviewedRevision === undefined || reviewedRevision === null) {
      report.failed.push({
        paper_uuid: draft.paper_uuid,
        draft_revision: draft.revision,
        error_code: "draft.invalid_review",
        message: "approved draft did not name its reviewed revision",
      });
      continue;
    }
    try {
      const outcome = await client.publishDraft(draft.paper_uuid, {
        expected_revision: reviewedRevision,
        idempotency_key: `paperbot-promote:${draft.paper_uuid}:${reviewedRevision}`,
      });
      report.published.push({
        paper_uuid: draft.paper_uuid,
        draft_revision: reviewedRevision,
        paper_id: outcome.paper.paper_id,
        paper_revision: outcome.paper.version,
        replayed: outcome.replayed,
        approval_kind: "human",
      });
    } catch (error) {
      if (
        error instanceof ProdxivApiError &&
        (error.code === "draft.revision_conflict" ||
          error.code === "draft.not_approved" ||
          error.code === "draft.not_found")
      ) {
        report.skipped.push({
          paper_uuid: draft.paper_uuid,
          draft_revision: reviewedRevision,
          reason: "draft_changed",
        });
        continue;
      }
      report.failed.push({
        paper_uuid: draft.paper_uuid,
        draft_revision: reviewedRevision,
        error_code:
          error instanceof ProdxivApiError
            ? error.code
            : "sync.unexpected_error",
        message: safeErrorMessage(error),
      });
    }
  }
  const pending = await client.listDrafts({
    limit: 100,
    review_status: "pending_review",
    owner_kind: "bot",
  });
  report.pending_bot_count = pending.drafts.length;
  for (const draft of pending.drafts) {
    try {
      const outcome = await client.approveAndPublishDraft(draft.paper_uuid, {
        expected_revision: draft.revision,
        idempotency_key: `paperbot-auto-publish:${draft.paper_uuid}:${draft.revision}`,
      });
      report.published.push({
        paper_uuid: draft.paper_uuid,
        draft_revision: draft.revision,
        paper_id: outcome.paper.paper_id,
        paper_revision: outcome.paper.version,
        replayed: outcome.replayed,
        approval_kind: "automatic",
      });
    } catch (error) {
      if (
        error instanceof ProdxivApiError &&
        (error.code === "draft.revision_conflict" ||
          error.code === "draft.not_found" ||
          error.code === "draft.owner_forbidden")
      ) {
        report.skipped.push({
          paper_uuid: draft.paper_uuid,
          draft_revision: draft.revision,
          reason:
            error.code === "draft.owner_forbidden"
              ? "ownership_changed"
              : "draft_changed",
        });
        continue;
      }
      report.failed.push({
        paper_uuid: draft.paper_uuid,
        draft_revision: draft.revision,
        error_code:
          error instanceof ProdxivApiError
            ? error.code
            : "sync.unexpected_error",
        message: safeErrorMessage(error),
      });
    }
  }
  return report;
}

export async function submitBatchDrafts(
  batchPath: string,
  expectedCount: number,
  client: DraftSyncClient,
): Promise<SubmissionReport> {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) {
    throw new Error("expected draft count must be a positive integer");
  }
  const absoluteBatchPath = resolve(batchPath);
  const batchRoot = dirname(absoluteBatchPath);
  const batch = parseBatchReport(
    JSON.parse(await readFile(absoluteBatchPath, "utf8")) as unknown,
  );
  const report: SubmissionReport = {
    schema_version: "1",
    expected_count: expectedCount,
    submitted: [],
    rotated: [],
    failed: [],
  };
  const succeeded = batch.projects.filter(
    (project) => project.state === "succeeded",
  );
  if (succeeded.length !== expectedCount) {
    throw new Error(
      `expected ${expectedCount} successful Paperbot runs, found ${succeeded.length}`,
    );
  }

  for (const project of succeeded) {
    try {
      const result = project.result;
      if (result === undefined) {
        throw new Error("successful project did not contain a run result");
      }
      if (
        result.state !== "needs_author_review" ||
        result.checkpoint.reason !== "needs_author_review"
      ) {
        throw new Error("successful auto run did not stop for author review");
      }
      const outputPath = resolve(project.output_path);
      assertInside(batchRoot, outputPath, "project output");
      if (resolve(result.run_path) !== outputPath) {
        throw new Error(
          "batch result run path did not match its project output",
        );
      }
      const paperPath = resolve(outputPath, "paper.md");
      assertInside(outputPath, paperPath, "paper artifact");
      const archivePath = resolve(outputPath, result.checkpoint.archive);
      assertInside(batchRoot, archivePath, "checkpoint archive");
      if (!basename(archivePath).endsWith("_final.zip")) {
        throw new Error("successful auto run did not produce a final ZIP");
      }
      const [sourceMarkdown, archive] = await Promise.all([
        readFile(paperPath, "utf8"),
        readFile(archivePath),
      ]);
      const archiveSha256 = new Bun.CryptoHasher("sha256")
        .update(archive)
        .digest("hex");
      if (archiveSha256 !== result.checkpoint.archive_sha256) {
        throw new Error("final ZIP digest did not match the batch checkpoint");
      }
      const draft = await client.createDraft({
        source_markdown: sourceMarkdown,
        idempotency_key: `paperbot-draft:${result.run_id}`,
      });
      report.submitted.push({
        project_index: project.project_index,
        repository_url: project.repository_url,
        run_id: result.run_id,
        paper_uuid: draft.paper_uuid,
        draft_revision: draft.revision,
        archive: relative(batchRoot, archivePath).replaceAll("\\", "/"),
        archive_sha256: archiveSha256,
      });
    } catch (error) {
      report.failed.push({
        project_index: project.project_index,
        repository_url: project.repository_url,
        message: safeErrorMessage(error),
      });
    }
  }
  try {
    report.rotated = await enforcePendingDraftLimit(client, 5);
  } catch (error) {
    report.failed.push({
      project_index: 0,
      repository_url: "paperbot:pending_rotation",
      message: safeErrorMessage(error),
    });
  }
  return report;
}

async function enforcePendingDraftLimit(
  client: DraftSyncClient,
  limit: number,
): Promise<SubmissionReport["rotated"]> {
  const rotated: SubmissionReport["rotated"] = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pending = await client.listDrafts({
      limit: 100,
      review_status: "pending_review",
      owner_kind: "bot",
    });
    if (pending.drafts.length <= limit) {
      return rotated;
    }
    const oldest = pending.drafts.at(-1);
    if (oldest === undefined) {
      throw new Error("pending draft rotation could not select an old draft");
    }
    try {
      await client.rejectDraft(oldest.paper_uuid, {
        expected_revision: oldest.revision,
        reason: "Rotated out of the five active daily Paperbot drafts.",
      });
      rotated.push({
        paper_uuid: oldest.paper_uuid,
        draft_revision: oldest.revision,
      });
    } catch (error) {
      if (
        error instanceof ProdxivApiError &&
        (error.code === "draft.revision_conflict" ||
          error.code === "draft.not_found")
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("pending draft rotation did not converge");
}

interface ParsedBatchReport {
  projects: ParsedBatchProject[];
}

interface ParsedBatchProject {
  project_index: number;
  repository_url: string;
  output_path: string;
  state: "pending" | "running" | "succeeded" | "failed";
  result?: {
    run_id: string;
    run_path: string;
    state: string;
    checkpoint: {
      reason: string;
      archive: string;
      archive_sha256: string;
    };
  };
}

function parseBatchReport(value: unknown): ParsedBatchReport {
  if (
    !isRecord(value) ||
    value.schema_version !== "2" ||
    !Array.isArray(value.projects)
  ) {
    throw new Error("Paperbot batch report is invalid");
  }
  return {
    projects: value.projects.map((project, index) =>
      parseBatchProject(project, index),
    ),
  };
}

function parseBatchProject(value: unknown, index: number): ParsedBatchProject {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.project_index) ||
    typeof value.repository_url !== "string" ||
    typeof value.output_path !== "string" ||
    !isBatchProjectState(value.state)
  ) {
    throw new Error(`Paperbot batch project ${index + 1} is invalid`);
  }
  const project: ParsedBatchProject = {
    project_index: value.project_index as number,
    repository_url: value.repository_url,
    output_path: value.output_path,
    state: value.state,
  };
  if (value.result !== undefined) {
    project.result = parseRunResult(value.result, index);
  }
  return project;
}

function parseRunResult(
  value: unknown,
  projectIndex: number,
): NonNullable<ParsedBatchProject["result"]> {
  if (
    !isRecord(value) ||
    typeof value.run_id !== "string" ||
    !/^[0-9a-f-]{36}$/.test(value.run_id) ||
    typeof value.run_path !== "string" ||
    typeof value.state !== "string" ||
    !isRecord(value.checkpoint) ||
    typeof value.checkpoint.reason !== "string" ||
    typeof value.checkpoint.archive !== "string" ||
    typeof value.checkpoint.archive_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.checkpoint.archive_sha256)
  ) {
    throw new Error(
      `Paperbot batch project ${projectIndex + 1} has an invalid run result`,
    );
  }
  return {
    run_id: value.run_id,
    run_path: value.run_path,
    state: value.state,
    checkpoint: {
      reason: value.checkpoint.reason,
      archive: value.checkpoint.archive,
      archive_sha256: value.checkpoint.archive_sha256,
    },
  };
}

function assertInside(root: string, path: string, label: string): void {
  const absoluteRoot = resolve(root);
  if (path !== absoluteRoot && !path.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`${label} escaped the evaluation directory`);
  }
}

function isBatchProjectState(
  value: unknown,
): value is ParsedBatchProject["state"] {
  return (
    value === "pending" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown draft sync failure";
}

function configuredApiUrl(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("PRODXIV_API_URL is required");
  }
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("PRODXIV_API_URL must use HTTPS or loopback HTTP");
  }
  return url.toString();
}

async function main(): Promise<void> {
  const token = process.env.PRODXIV_BOT_TOKEN;
  if (token === undefined || token.length < 32) {
    throw new Error("PRODXIV_BOT_TOKEN must contain at least 32 characters");
  }
  const client = new ProdxivApiClient({
    api_url: configuredApiUrl(process.env.PRODXIV_API_URL),
    token,
  });
  const [command, inputPath, expectedCountValue] = process.argv.slice(2);
  let report: PromotionReport | SubmissionReport;
  if (command === "promote") {
    report = await promoteDrafts(client);
  } else if (command === "submit" && inputPath !== undefined) {
    const expectedCount = Number(expectedCountValue ?? "3");
    report = await submitBatchDrafts(inputPath, expectedCount, client);
  } else {
    throw new Error(
      "usage: sync-drafts.ts promote | submit <batch.json> [expected-count]",
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.failed.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
