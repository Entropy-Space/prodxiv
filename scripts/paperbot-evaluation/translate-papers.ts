import { createHash } from "node:crypto";
import {
  ProdxivApiClient,
  type PaperTranslation,
  type TranslationJob,
} from "../../packages/api-client/src/client.ts";
import { PiAgentRuntime } from "../../apps/paperbot/src/agent/pi.ts";
import { resolveApiBearerToken } from "../github-actions/oidc.ts";
import {
  TranslationWorkerError,
  translationDiagnostic,
  type TranslationDiagnostic,
  type TranslationStage,
} from "./translation-errors.ts";
import {
  TRANSLATION_SYSTEM_PROMPT,
  translatePaper,
} from "./translation-model.ts";

interface TranslationClient {
  listTranslationJobs(): Promise<TranslationJob[]>;
  finishTranslation: ProdxivApiClient["finishTranslation"];
}
export type Translate = (
  job: TranslationJob,
  markdown: string,
) => Promise<
  Pick<PaperTranslation, "title" | "summary" | "markdown" | "model">
>;

export function paperBody(source: string): string {
  const prefix = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(source);
  if (prefix === null)
    throw new TranslationWorkerError("translation.invalid_source");
  return source.slice(prefix[0].length);
}

export async function translatePendingPapers(
  client: TranslationClient,
  translate: Translate,
) {
  const report: {
    schema_version: "2";
    errors: TranslationDiagnostic[];
    completed: Array<{ paper_id: string; revision: number; language: string }>;
    failed: Array<{
      paper_id: string;
      revision: number;
      language: string;
      failure_recorded: boolean;
      error: TranslationDiagnostic;
      failure_record_error?: TranslationDiagnostic;
    }>;
  } = { schema_version: "2", errors: [], completed: [], failed: [] };
  let jobs: TranslationJob[];
  try {
    jobs = await client.listTranslationJobs();
  } catch (error) {
    report.errors.push(translationDiagnostic(error, "load_jobs"));
    return report;
  }
  // One bounded snapshot per invocation: a failed language is retried next run,
  // never repeatedly in the same run or at the expense of sibling languages.
  for (const job of jobs) {
    const identity = {
      paper_id: job.paper.paper_id,
      revision: job.paper.version,
      language: job.language,
    };
    let stage: TranslationStage = "source";
    try {
      if (
        createHash("sha256").update(job.paper.source_markdown).digest("hex") !==
        job.source_sha256
      )
        throw new TranslationWorkerError("translation.source_digest_mismatch");
      const markdown = paperBody(job.paper.source_markdown);
      stage = "translate";
      const content =
        job.language === "en"
          ? {
              title: job.paper.metadata.title,
              summary: job.paper.metadata.summary,
              markdown,
              model: "source-copy",
            }
          : await translate(job, markdown);
      stage = "save_translation";
      await client.finishTranslation(job, {
        status: "completed",
        translation: {
          ...content,
          language: job.language,
          source_sha256: job.source_sha256,
        },
      });
      report.completed.push(identity);
    } catch (error) {
      let failureRecorded = false;
      let failureRecordError: TranslationDiagnostic | undefined;
      try {
        await client.finishTranslation(job, {
          status: "failed",
          source_sha256: job.source_sha256,
        });
        failureRecorded = true;
      } catch (recordError) {
        failureRecordError = translationDiagnostic(
          recordError,
          "record_failure",
        );
      }
      report.failed.push({
        ...identity,
        failure_recorded: failureRecorded,
        error: translationDiagnostic(error, stage),
        ...(failureRecordError === undefined
          ? {}
          : { failure_record_error: failureRecordError }),
      });
    }
  }
  return report;
}

async function main() {
  const url = new URL(process.env.PRODXIV_API_URL ?? "");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error("API URL must be anonymous HTTPS or loopback HTTP");
  const client = new ProdxivApiClient({
    api_url: url.href,
    token_provider: () => resolveApiBearerToken("PRODXIV_BOT_TOKEN"),
  });
  const runtime = new PiAgentRuntime({
    model: process.env.PAPERBOT_MODEL ?? "deepseek-v4-flash",
    system_prompt: TRANSLATION_SYSTEM_PROMPT,
  });
  const report = await translatePendingPapers(client, (job, markdown) =>
    translatePaper(runtime, job, markdown),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.failed.length > 0 || report.errors.length > 0)
    process.exitCode = 1;
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify(translationDiagnostic(error, "startup"))}\n`,
    );
    process.exitCode = 1;
  });
}
