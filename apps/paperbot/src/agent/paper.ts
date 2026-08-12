import { marked, type Token, type Tokens } from "marked";

import {
  ExitCode,
  PaperbotError,
  validatePaperSource,
  type PaperValidationResult,
} from "@prodxiv/paperbot-core";
import { artifactPath } from "./artifacts.ts";
import { evidenceIds } from "./evidence.ts";
import { normalizeAnonymousHttpUrl } from "./input.ts";
import { validateAuthoringEvidenceIds } from "./responses.ts";
import type {
  AgentPaperMetadata,
  DraftResponse,
  EvidenceItem,
} from "./types.ts";

export interface DraftAssessment {
  action: "submit_draft";
  draft: DraftResponse;
  paper: string;
  validation: PaperValidationResult;
  diagnostics: string[];
}

export function renderPaper(
  metadata: AgentPaperMetadata,
  draft: Pick<DraftResponse, "summary" | "topics" | "markdown">,
): string {
  const frontMatter = [
    'schema_version: "2"',
    `title: ${JSON.stringify(metadata.title)}`,
    `product_name: ${JSON.stringify(metadata.product_name)}`,
    "scope:",
    "  kind: product",
    `summary: ${JSON.stringify(draft.summary.trim())}`,
    "authors:",
    ...metadata.authors.flatMap((author) => [
      ...(author.id === undefined
        ? ["  - kind: " + JSON.stringify(author.kind)]
        : [
            `  - id: ${JSON.stringify(author.id)}`,
            `    kind: ${JSON.stringify(author.kind)}`,
          ]),
      `    name: ${JSON.stringify(author.name)}`,
      ...(author.url === undefined
        ? []
        : [`    url: ${JSON.stringify(author.url)}`]),
    ]),
    "writers:",
    ...metadata.writers.flatMap((writer) => [
      `  - kind: ${JSON.stringify(writer.kind)}`,
      `    name: ${JSON.stringify(writer.name)}`,
      `    model: ${JSON.stringify(writer.model)}`,
      `    tool_version: ${JSON.stringify(writer.tool_version)}`,
      `    generation_id: ${JSON.stringify(writer.generation_id)}`,
    ]),
    "status:",
    `  value: ${JSON.stringify(metadata.status.value)}`,
    `  determination: ${JSON.stringify(metadata.status.determination)}`,
    `  confidence: ${JSON.stringify(metadata.status.confidence)}`,
    ...(metadata.status.observed_at === undefined
      ? []
      : [`  observed_at: ${JSON.stringify(metadata.status.observed_at)}`]),
    ...(metadata.status.evidence === undefined
      ? []
      : [
          "  evidence:",
          ...metadata.status.evidence.flatMap((evidence) => [
            `    - kind: ${JSON.stringify(evidence.kind)}`,
            `      url: ${JSON.stringify(evidence.url)}`,
            `      tag: ${JSON.stringify(evidence.tag)}`,
          ]),
        ]),
    "topics:",
    ...draft.topics.map((topic) => `  - ${JSON.stringify(topic)}`),
    ...(metadata.product_url === undefined
      ? []
      : [`product_url: ${JSON.stringify(metadata.product_url)}`]),
    ...(metadata.repository_url === undefined
      ? []
      : [`repository_url: ${JSON.stringify(metadata.repository_url)}`]),
  ].join("\n");
  const notice = [
    "> **Private research draft.** This paper was generated from bounded repository, release, and author evidence and has not been reviewed or endorsed by the repository owner.",
    "> Repository-owner attribution and inferred product status must be confirmed together with factual claims, related-work comparisons, and publication rights before submission.",
  ].join("\n");
  return `---\n${frontMatter}\n---\n\n${notice}\n\n${draft.markdown.trim()}\n`;
}

export function assessDraft(
  metadata: AgentPaperMetadata,
  externalSources: string[],
  evidence: EvidenceItem[],
  runPath: string,
  draft: DraftResponse,
): DraftAssessment {
  const diagnostics = draftFieldDiagnostics(draft);
  if (evidence.length > 0 && draft.evidence_ids.length === 0) {
    diagnostics.push("draft must cite at least one validated evidence_id");
  }
  try {
    validateAuthoringEvidenceIds(draft, evidenceIds(evidence));
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
  }
  diagnostics.push(
    ...draftLinkDiagnostics(
      draft.markdown,
      allowedMarkdownUrls(metadata, externalSources),
    ),
  );
  const paper = renderPaper(metadata, draft);
  const validation = validatePaperSource(
    paper,
    artifactPath(runPath, "paper.md"),
    "draft",
  );
  diagnostics.push(
    ...validation.report.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map(
        (diagnostic) =>
          `${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
      ),
  );
  return {
    action: "submit_draft",
    draft,
    paper,
    validation,
    diagnostics: [...new Set(diagnostics)],
  };
}

export function emptyDraftResponse(evidence: EvidenceItem[]): DraftResponse {
  return {
    action: "submit_draft",
    summary: "A corrected draft is required.",
    topics: ["research_draft"],
    markdown: "# Summary\n\nA corrected draft is required.",
    evidence_ids: evidence.map((item) => item.evidence_id),
    unresolved_questions: [],
  };
}

export function draftFromPaper(
  paper: string,
  evidence: EvidenceItem[],
): DraftResponse {
  const frontMatterEnd = paper.indexOf("\n---\n");
  if (!paper.startsWith("---\n") || frontMatterEnd === -1) {
    throw new PaperbotError("agent draft is missing front matter", ExitCode.io);
  }
  const frontMatter = paper.slice(4, frontMatterEnd);
  const summary =
    readJsonFrontMatterString(frontMatter, "summary") ??
    "Existing private research draft.";
  const topics = readFrontMatterTopics(frontMatter);
  const markdown = paper
    .slice(frontMatterEnd + "\n---\n".length)
    .replace(
      /^\s*> \*\*Private research draft\.\*\*[\s\S]*?publication rights before submitting it\.\n\n/,
      "",
    );
  return {
    action: "submit_draft",
    summary,
    topics: topics.length === 0 ? ["research_draft"] : topics,
    markdown,
    evidence_ids: evidence.map((item) => item.evidence_id),
    unresolved_questions: [],
  };
}

function draftFieldDiagnostics(draft: DraftResponse): string[] {
  const diagnostics: string[] = [];
  if (draft.topics.length === 0 || draft.topics.length > 5) {
    diagnostics.push("topics must contain one to five labels");
  }
  const seen = new Set<string>();
  for (const topic of draft.topics) {
    if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(topic) || seen.has(topic)) {
      diagnostics.push("topics must be unique lowercase snake_case labels");
      break;
    }
    seen.add(topic);
  }
  if (/^#\s+Benchmarks\s*$/im.test(draft.markdown)) {
    diagnostics.push(
      "remove the Benchmarks section because no explicit reproducible benchmark input was supplied",
    );
  }
  return diagnostics;
}

function allowedMarkdownUrls(
  metadata: AgentPaperMetadata,
  externalSources: string[],
): Set<string> {
  return new Set(
    [
      metadata.repository_url,
      metadata.product_url,
      ...(metadata.status.evidence ?? []).map((item) => item.url),
      ...externalSources,
    ]
      .filter((url): url is string => url !== undefined)
      .map((url) => normalizeAnonymousHttpUrl(url, "draft link")),
  );
}

function validateDraftLinks(
  markdown: string,
  allowedUrls: ReadonlySet<string>,
): void {
  let tokens: Token[];
  try {
    tokens = marked.lexer(markdown);
  } catch {
    throw new PaperbotError(
      "agent draft Markdown could not be parsed for link validation",
      ExitCode.validation,
    );
  }
  marked.walkTokens(tokens, (token) => {
    if (isRawHtmlToken(token)) {
      throw new PaperbotError(
        "agent draft contains raw HTML; use Markdown links and a host-reviewed figure instead",
        ExitCode.validation,
      );
    }
    if (isMarkdownUrlToken(token)) {
      validateMarkdownUrl(token.href, allowedUrls);
    }
  });
}

function draftLinkDiagnostics(
  markdown: string,
  allowedUrls: ReadonlySet<string>,
): string[] {
  try {
    validateDraftLinks(markdown, allowedUrls);
    return [];
  } catch (error) {
    if (error instanceof PaperbotError) {
      return [error.message];
    }
    throw error;
  }
}

function isMarkdownUrlToken(
  token: Token,
): token is Tokens.Link | Tokens.Image | Tokens.Def {
  return (
    token.type === "link" || token.type === "image" || token.type === "def"
  );
}

function isRawHtmlToken(token: Token): token is Tokens.HTML | Tokens.Tag {
  return token.type === "html";
}

function validateMarkdownUrl(
  target: string,
  allowedUrls: ReadonlySet<string>,
): void {
  let normalized: string;
  try {
    normalized = normalizeAnonymousHttpUrl(target, "draft link");
  } catch {
    throw new PaperbotError(
      `agent draft contains an unsupported Markdown link: ${target}`,
      ExitCode.validation,
    );
  }
  if (!allowedUrls.has(normalized)) {
    throw new PaperbotError(
      `agent draft links to an unprovided URL: ${normalized}`,
      ExitCode.validation,
    );
  }
}

function readJsonFrontMatterString(
  frontMatter: string,
  field: string,
): string | undefined {
  const match = frontMatter.match(new RegExp(`^${field}: (.+)$`, "m"));
  if (match?.[1] === undefined) {
    return undefined;
  }
  try {
    const value = JSON.parse(match[1]) as unknown;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function readFrontMatterTopics(frontMatter: string): string[] {
  const lines = frontMatter.split("\n");
  const start = lines.indexOf("topics:");
  if (start === -1) {
    return [];
  }
  const topics: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^  - (.+)$/);
    if (match?.[1] === undefined) {
      break;
    }
    try {
      const value = JSON.parse(match[1]) as unknown;
      if (typeof value === "string") {
        topics.push(value);
      }
    } catch {
      return [];
    }
  }
  return topics;
}
