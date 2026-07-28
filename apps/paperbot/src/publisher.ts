import {
  ProdxivApiClient,
  type ApiFetch,
  type PublishPaperResult,
} from "@prodxiv/api-client";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  resolveAuth,
  type AuthResolutionOptions,
  type ResolvedAuth,
} from "./auth.ts";
import type { Diagnostic } from "@prodxiv/contracts/validation";
import { ExitCode, PaperbotError } from "./errors.ts";
import { parsePaper } from "./validation/paper.ts";
import {
  validatePaperSource,
  type PaperValidationResult,
} from "./validator.ts";

export interface PublicationResult {
  format_version: 1;
  paper_id: string;
  version: number;
  published_at: string;
  location: string;
  source_sha256: string;
  replayed: boolean;
}

export interface PreparePublicationOptions extends AuthResolutionOptions {
  fetch?: ApiFetch;
}

export interface PublicationPreparationResult {
  validation: PaperValidationResult;
  publication?: PreparedPublication;
}

export class PreparedPublication {
  readonly input_path: string;
  readonly title: string;
  readonly api_url: string;
  readonly auth_source: ResolvedAuth["source"];
  readonly source_sha256: string;
  readonly idempotency_key: string;
  readonly #sourceMarkdown: string;
  readonly #client: ProdxivApiClient;

  constructor(
    inputPath: string,
    title: string,
    sourceMarkdown: string,
    auth: ResolvedAuth,
    fetchImplementation?: ApiFetch,
  ) {
    this.input_path = inputPath;
    this.title = title;
    this.api_url = auth.api_url;
    this.auth_source = auth.source;
    this.source_sha256 = new Bun.CryptoHasher("sha256")
      .update(sourceMarkdown)
      .digest("hex");
    this.idempotency_key = `paperbot.v1.${this.source_sha256}`;
    this.#sourceMarkdown = sourceMarkdown;
    this.#client = new ProdxivApiClient({
      api_url: auth.api_url,
      token: auth.token,
      ...(fetchImplementation === undefined
        ? {}
        : { fetch: fetchImplementation }),
    });
  }

  async publish(): Promise<PublicationResult> {
    const result = await this.#client.publishPaper({
      source_markdown: this.#sourceMarkdown,
      idempotency_key: this.idempotency_key,
    });
    return publicationResult(result, this.api_url, this.source_sha256);
  }
}

export async function preparePublication(
  inputPath: string,
  options: PreparePublicationOptions = {},
): Promise<PublicationPreparationResult> {
  const absoluteInputPath = resolve(inputPath);
  let sourceMarkdown: string;
  try {
    sourceMarkdown = await readFile(absoluteInputPath, "utf8");
  } catch {
    throw new PaperbotError(`could not read paper: ${inputPath}`, ExitCode.io);
  }
  const validation = validatePaperSource(
    sourceMarkdown,
    absoluteInputPath,
    "submission",
  );
  if (!validation.report.valid) {
    return { validation };
  }
  const diagnostics: Diagnostic[] = [];
  const paper = parsePaper(sourceMarkdown, diagnostics);
  if (paper === undefined) {
    throw new PaperbotError(
      "paper could not be prepared after validation",
      ExitCode.validation,
    );
  }
  const auth = await resolveAuth(options);
  return {
    validation,
    publication: new PreparedPublication(
      absoluteInputPath,
      paper.metadata.title || basename(absoluteInputPath),
      sourceMarkdown,
      auth,
      options.fetch,
    ),
  };
}

function publicationResult(
  result: PublishPaperResult,
  apiUrl: string,
  sourceSha256: string,
): PublicationResult {
  return {
    format_version: 1,
    paper_id: result.paper.paper_id,
    version: result.paper.version,
    published_at: result.paper.published_at,
    location: new URL(result.location, `${apiUrl}/`).toString(),
    source_sha256: sourceSha256,
    replayed: result.replayed,
  };
}
