import type { PaperDocument } from "@prodxiv/contracts/paper";
import { validation_policy } from "@prodxiv/contracts/validation-policy";
import type { Diagnostic } from "@prodxiv/contracts/validation";
import { marked, type Token, type Tokens } from "marked";

import type { ValidationProfile } from "./profile.ts";
import { diagnostic, isHttpUrl, isRecord } from "./shared.ts";

export function parsePaper(
  source: string,
  diagnostics: Diagnostic[],
): PaperDocument | undefined {
  const withoutBom = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const delimiter = withoutBom.startsWith("---\r\n")
    ? "\r\n---\r\n"
    : withoutBom.startsWith("---\n")
      ? "\n---\n"
      : undefined;
  if (delimiter === undefined) {
    diagnostics.push(
      diagnostic(
        "paper.front_matter_missing",
        "paper",
        "paper must begin with YAML front matter delimited by `---`",
      ),
    );
    return undefined;
  }

  const openingLength = delimiter.startsWith("\r\n") ? 5 : 4;
  const frontMatterAndBody = withoutBom.slice(openingLength);
  const closingIndex = frontMatterAndBody.indexOf(delimiter);
  if (closingIndex === -1) {
    diagnostics.push(
      diagnostic(
        "paper.front_matter_unterminated",
        "paper",
        "paper front matter is missing its closing `---` delimiter",
      ),
    );
    return undefined;
  }

  const frontMatter = frontMatterAndBody.slice(0, closingIndex);
  const markdown = frontMatterAndBody.slice(closingIndex + delimiter.length);
  try {
    return {
      metadata: Bun.YAML.parse(frontMatter) as PaperDocument["metadata"],
      markdown,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push(
      diagnostic(
        "paper.front_matter_invalid",
        "paper.metadata",
        `paper front matter is invalid: ${message}`,
      ),
    );
    return undefined;
  }
}

export function validatePaperRules(
  paper: PaperDocument,
  profile: ValidationProfile,
  diagnostics: Diagnostic[],
): void {
  const metadata: unknown = paper.metadata;
  if (!isRecord(metadata)) {
    validateSections(paper.markdown, diagnostics);
    return;
  }

  validateRequiredText(metadata, diagnostics);
  validateAuthors(metadata, diagnostics);
  validateWritersAndContact(metadata, diagnostics);
  validateStatus(metadata, diagnostics);
  validateTopics(metadata, diagnostics);
  validatePublicationValues(metadata, diagnostics);
  validateUrls(metadata, diagnostics);
  validateScope(metadata.scope, diagnostics);

  if (profile === "submission") {
    if (metadata.schema_version === "1") {
      diagnostics.push(
        diagnostic(
          "submission.current_schema_required",
          "metadata.schema_version",
          "schema version 1 papers remain readable but new submissions must use schema version 2",
        ),
      );
    }
    for (const field of validation_policy.paper.submission_forbidden_metadata) {
      if (metadata[field] !== undefined && metadata[field] !== null) {
        diagnostics.push(submissionForbiddenDiagnostic(field));
      }
    }
    for (const field of validation_policy.paper.submission_required_metadata) {
      if (metadata[field] === undefined || metadata[field] === null) {
        diagnostics.push(submissionRequiredDiagnostic(field));
      }
    }
  } else if (profile === "publication") {
    for (const field of validation_policy.paper.publication_required_metadata) {
      if (metadata[field] === undefined || metadata[field] === null) {
        diagnostics.push(publicationRequiredDiagnostic(field));
      }
    }
  }

  validateSections(paper.markdown, diagnostics);
}

function submissionForbiddenDiagnostic(field: string): Diagnostic {
  const values: Record<string, [string, string]> = {
    paper_id: [
      "submission.paper_id_forbidden",
      "paper identifiers are assigned by the publishing service",
    ],
    published_at: [
      "submission.date_forbidden",
      "publication dates are assigned by the publishing service",
    ],
    version: [
      "submission.version_forbidden",
      "paper revisions are assigned by the publishing service",
    ],
  };
  const [code, message] = values[field] ?? [
    "submission.metadata_forbidden",
    "submission metadata is assigned by the publishing service",
  ];
  return diagnostic(code, `metadata.${field}`, message);
}

function submissionRequiredDiagnostic(field: string): Diagnostic {
  const [code, message] =
    field === "license"
      ? ["submission.license_required", "submitted papers require a license"]
      : field === "product_name"
        ? [
            "submission.product_name_required",
            "submitted papers must identify their product",
          ]
        : field === "scope"
          ? [
              "submission.scope_required",
              "submitted papers must identify their scope",
            ]
          : [
              "submission.metadata_required",
              "submitted paper metadata is required",
            ];
  return diagnostic(code, `metadata.${field}`, message);
}

function validateRequiredText(
  metadata: Record<string, unknown>,
  diagnostics: Diagnostic[],
): void {
  for (const field of ["title", "summary", "product_name"] as const) {
    const value = metadata[field];
    if (typeof value === "string" && value.trim().length === 0) {
      diagnostics.push(
        diagnostic(
          "value.required",
          `metadata.${field}`,
          "value must not be empty",
        ),
      );
    }
  }
}

function validateScope(value: unknown, diagnostics: Diagnostic[]): void {
  if (!isRecord(value)) {
    return;
  }
  if (
    value.kind === "product" &&
    (value.name !== undefined || value.product_version !== undefined)
  ) {
    diagnostics.push(
      diagnostic(
        "scope.product_has_detail",
        "metadata.scope",
        "product scope must not specify a feature name or product version",
      ),
    );
  } else if (
    value.kind === "feature" &&
    (typeof value.name !== "string" || value.name.trim().length === 0)
  ) {
    diagnostics.push(
      diagnostic(
        "scope.feature_name_required",
        "metadata.scope.name",
        "feature scope requires a name",
      ),
    );
  } else if (
    value.kind === "release" &&
    (typeof value.product_version !== "string" ||
      value.product_version.trim().length === 0)
  ) {
    diagnostics.push(
      diagnostic(
        "scope.product_version_required",
        "metadata.scope.product_version",
        "release scope requires a product version",
      ),
    );
  }
}

function validateAuthors(
  metadata: Record<string, unknown>,
  diagnostics: Diagnostic[],
): void {
  if (!Array.isArray(metadata.authors)) {
    return;
  }
  metadata.authors.forEach((author, index) => {
    if (!isRecord(author)) {
      return;
    }
    if (metadata.schema_version === "2" && author.kind == null) {
      diagnostics.push(
        diagnostic(
          "authors.kind_required",
          `metadata.authors[${index}].kind`,
          "schema version 2 authors must identify whether they are a person or organization",
        ),
      );
    }
    if (
      typeof author.id === "string" &&
      !/^[a-z][a-z0-9_-]*:[^\s:][^\s]*$/.test(author.id)
    ) {
      diagnostics.push(
        diagnostic(
          "authors.invalid_id",
          `metadata.authors[${index}].id`,
          "author IDs must use a namespaced value such as `github:owner`",
        ),
      );
    }
    if (typeof author.name === "string" && author.name.trim().length === 0) {
      diagnostics.push(
        diagnostic(
          "value.required",
          `metadata.authors[${index}].name`,
          "value must not be empty",
        ),
      );
    }
    if (typeof author.url === "string" && !isHttpUrl(author.url)) {
      diagnostics.push(
        diagnostic(
          "value.invalid_url",
          `metadata.authors[${index}].url`,
          "URL must be an absolute HTTP or HTTPS URL",
        ),
      );
    }
  });
}

function validateWritersAndContact(
  metadata: Record<string, unknown>,
  diagnostics: Diagnostic[],
): void {
  if (metadata.schema_version === "1") {
    if (Array.isArray(metadata.writers) && metadata.writers.length > 0) {
      diagnostics.push(
        diagnostic(
          "schema.v1_writers_forbidden",
          "metadata.writers",
          "writers require paper schema version 2",
        ),
      );
    }
    if (metadata.communication_email != null) {
      diagnostics.push(
        diagnostic(
          "schema.v1_communication_email_forbidden",
          "metadata.communication_email",
          "communication_email requires paper schema version 2",
        ),
      );
    }
    return;
  }
  if (metadata.schema_version !== "2") {
    return;
  }
  if (!Array.isArray(metadata.writers) || metadata.writers.length === 0) {
    diagnostics.push(
      diagnostic(
        "writers.required",
        "metadata.writers",
        "schema version 2 papers require at least one writer",
      ),
    );
    return;
  }
  metadata.writers.forEach((writer, index) => {
    if (!isRecord(writer)) {
      return;
    }
    if (writer.kind === "human" && writer.model != null) {
      diagnostics.push(
        diagnostic(
          "writers.human_model_forbidden",
          `metadata.writers[${index}].model`,
          "human writers must not specify a model",
        ),
      );
    }
    if (
      writer.kind === "agent" &&
      (typeof writer.model !== "string" || writer.model.trim().length === 0)
    ) {
      diagnostics.push(
        diagnostic(
          "writers.agent_model_required",
          `metadata.writers[${index}].model`,
          "agent writers must identify their model",
        ),
      );
    }
  });
  if (
    metadata.communication_email != null &&
    !metadata.writers.some(
      (writer) => isRecord(writer) && writer.kind === "human",
    )
  ) {
    diagnostics.push(
      diagnostic(
        "communication_email.human_writer_required",
        "metadata.communication_email",
        "communication_email is available only when a human writer is credited",
      ),
    );
  }
}

function validateStatus(
  metadata: Record<string, unknown>,
  diagnostics: Diagnostic[],
): void {
  if (metadata.schema_version === "1") {
    if (metadata.status === "unknown") {
      diagnostics.push(
        diagnostic(
          "status.v1_unknown_forbidden",
          "metadata.status",
          "unknown status requires paper schema version 2",
        ),
      );
    } else if (isRecord(metadata.status)) {
      diagnostics.push(
        diagnostic(
          "status.v1_scalar_required",
          "metadata.status",
          "schema version 1 status must be a scalar value",
        ),
      );
    }
    return;
  }
  if (metadata.schema_version !== "2") {
    return;
  }
  if (!isRecord(metadata.status)) {
    diagnostics.push(
      diagnostic(
        "status.v2_observation_required",
        "metadata.status",
        "schema version 2 status must include its determination and confidence",
      ),
    );
    return;
  }
  const status = metadata.status;
  if (
    (status.value === "unknown") !==
    (status.determination === "unverified")
  ) {
    diagnostics.push(
      diagnostic(
        "status.invalid_unverified_value",
        "metadata.status",
        "unknown status and unverified determination must be used together",
      ),
    );
  }
  if (status.determination === "inferred") {
    if (!Array.isArray(status.evidence) || status.evidence.length === 0) {
      diagnostics.push(
        diagnostic(
          "status.inferred_evidence_required",
          "metadata.status.evidence",
          "inferred status requires at least one evidence reference",
        ),
      );
    }
    if (typeof status.observed_at !== "string") {
      diagnostics.push(
        diagnostic(
          "status.inferred_observed_at_required",
          "metadata.status.observed_at",
          "inferred status requires an observation timestamp",
        ),
      );
    }
  }
  if (
    typeof status.observed_at === "string" &&
    !isUtcTimestamp(status.observed_at)
  ) {
    diagnostics.push(
      diagnostic(
        "status.invalid_observed_at",
        "metadata.status.observed_at",
        "status observation timestamps must use UTC RFC 3339 notation",
      ),
    );
  }
  if (Array.isArray(status.evidence)) {
    const urls = new Set<string>();
    status.evidence.forEach((item, index) => {
      if (!isRecord(item)) {
        return;
      }
      if (typeof item.url === "string") {
        if (!isHttpUrl(item.url)) {
          diagnostics.push(
            diagnostic(
              "value.invalid_url",
              `metadata.status.evidence[${index}].url`,
              "URL must be an absolute HTTP or HTTPS URL",
            ),
          );
        }
        if (urls.has(item.url)) {
          diagnostics.push(
            diagnostic(
              "status.duplicate_evidence",
              `metadata.status.evidence[${index}].url`,
              "status evidence URLs must be unique",
            ),
          );
        }
        urls.add(item.url);
      }
    });
  }
}

function validateTopics(
  metadata: Record<string, unknown>,
  diagnostics: Diagnostic[],
): void {
  if (!Array.isArray(metadata.topics)) {
    return;
  }
  const seenTopics = new Set<string>();
  metadata.topics.forEach((topic, index) => {
    if (typeof topic !== "string") {
      return;
    }
    if (seenTopics.has(topic)) {
      diagnostics.push(
        diagnostic(
          "topics.duplicate",
          `metadata.topics[${index}]`,
          "topics must be unique",
        ),
      );
    }
    seenTopics.add(topic);
  });
}

function validatePublicationValues(
  metadata: Record<string, unknown>,
  diagnostics: Diagnostic[],
): void {
  if (
    typeof metadata.published_at === "string" &&
    !isIsoDate(metadata.published_at)
  ) {
    diagnostics.push(
      diagnostic(
        "publication.invalid_date",
        "metadata.published_at",
        "publication date must use YYYY-MM-DD",
      ),
    );
  }
  if (
    typeof metadata.license === "string" &&
    metadata.license.trim().length === 0
  ) {
    diagnostics.push(
      diagnostic(
        "publication.invalid_license",
        "metadata.license",
        "license must not be empty",
      ),
    );
  }
}

function validateUrls(
  metadata: Record<string, unknown>,
  diagnostics: Diagnostic[],
): void {
  for (const field of ["product_url", "repository_url"] as const) {
    const value = metadata[field];
    if (typeof value === "string" && !isHttpUrl(value)) {
      diagnostics.push(
        diagnostic(
          "value.invalid_url",
          `metadata.${field}`,
          "URL must be an absolute HTTP or HTTPS URL",
        ),
      );
    }
  }
}

function validateSections(markdown: string, diagnostics: Diagnostic[]): void {
  const headings = marked
    .lexer(markdown)
    .filter(isLevelOneHeading)
    .map((token) => token.text.trim());
  const counts = new Map<string, number>();
  for (const heading of headings) {
    counts.set(heading, (counts.get(heading) ?? 0) + 1);
  }

  let lastPosition: number | undefined;
  for (const section of validation_policy.paper.required_sections) {
    const position = headings.indexOf(section);
    if (position === -1) {
      diagnostics.push(
        diagnostic(
          "sections.missing",
          "markdown",
          `required level-one section \`${section}\` is missing`,
        ),
      );
      continue;
    }
    if ((counts.get(section) ?? 0) > 1) {
      diagnostics.push(
        diagnostic(
          "sections.duplicate",
          "markdown",
          `required level-one section \`${section}\` appears more than once`,
        ),
      );
    }
    if (lastPosition !== undefined && position < lastPosition) {
      diagnostics.push(
        diagnostic(
          "sections.out_of_order",
          "markdown",
          `required level-one section \`${section}\` is out of order`,
        ),
      );
    }
    lastPosition = position;
  }
}

function publicationRequiredDiagnostic(field: string): Diagnostic {
  const values: Record<string, [string, string]> = {
    paper_id: [
      "publication.paper_id_required",
      "published papers require an archive identifier",
    ],
    published_at: [
      "publication.date_required",
      "published papers require a publication date",
    ],
    version: [
      "publication.revision_required",
      "published papers require a positive revision",
    ],
    license: [
      "publication.license_required",
      "published papers require a license",
    ],
    product_name: [
      "publication.product_name_required",
      "published papers must identify their product",
    ],
    scope: [
      "publication.scope_required",
      "published papers must identify their scope",
    ],
  };
  const [code, message] = values[field] ?? [
    "publication.metadata_required",
    "published paper metadata is required",
  ];
  return diagnostic(code, `metadata.${field}`, message);
}

function isIsoDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maximumDay = [
    0,
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month];
  return maximumDay !== undefined && day >= 1 && day <= maximumDay;
}

function isUtcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
    return false;
  }
  const timestamp = new Date(value);
  return (
    !Number.isNaN(timestamp.valueOf()) &&
    timestamp.toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

function isLevelOneHeading(token: Token): token is Tokens.Heading {
  return token.type === "heading" && token.depth === 1;
}
