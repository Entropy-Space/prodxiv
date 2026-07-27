import type { PaperDocument } from "@prodxiv/contracts/paper";
import { validation_policy } from "@prodxiv/contracts/validation-policy";
import type { Diagnostic } from "@prodxiv/contracts/validation";
import { marked, type Token, type Tokens } from "marked";

import type { ValidationProfile } from "../arguments.ts";
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
  validateTopics(metadata, diagnostics);
  validatePublicationValues(metadata, diagnostics);
  validateUrls(metadata, diagnostics);

  if (profile === "publication") {
    for (const field of validation_policy.paper.publication_required_metadata) {
      if (metadata[field] === undefined || metadata[field] === null) {
        diagnostics.push(publicationRequiredDiagnostic(field));
      }
    }
  }

  validateSections(paper.markdown, diagnostics);
}

function validateRequiredText(
  metadata: Record<string, unknown>,
  diagnostics: Diagnostic[],
): void {
  for (const field of ["title", "summary"] as const) {
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
      "publication.version_required",
      "published papers require a positive version",
    ],
    license: [
      "publication.license_required",
      "published papers require a license",
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

function isLevelOneHeading(token: Token): token is Tokens.Heading {
  return token.type === "heading" && token.depth === 1;
}
