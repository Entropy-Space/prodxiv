import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import type { EvidenceBundle } from "@prodxiv/contracts/evidence";
import { validation_policy } from "@prodxiv/contracts/validation-policy";
import type { ValidationReport } from "@prodxiv/contracts/validation";

import { ExitCode, PaperbotError } from "./errors.ts";
import { validateEvidenceValue } from "./validation/evidence.ts";
import { isSafeRelativePath, sortDiagnostics } from "./validation/shared.ts";

const MAX_EVIDENCE_BUNDLE_BYTES = 5 * 1024 * 1024;

const SECTION_PROMPTS = [
  [
    "Summary",
    "Summarize what the product is and who it serves. Keep unsupported claims explicit.",
  ],
  [
    "Background",
    "Describe the context supported by documentation, then ask the author about missing history.",
  ],
  [
    "Motivation",
    "Author input required: what problem motivated the product, and why were existing options insufficient?",
  ],
  [
    "Related Work",
    "Identify documented alternatives and influences. Do not infer competitive claims from marketing copy.",
  ],
  [
    "Core Features",
    "Describe implementation-backed features and link each substantive claim to evidence.",
  ],
  [
    "Architecture",
    "Explain the observed architecture, dependencies, and boundaries. Mark interpretations as inferred.",
  ],
  [
    "Benchmarks",
    "Do not invent results. Record reproducible methodology or state that no benchmark evidence was found.",
  ],
  [
    "Insights and Lessons",
    "Author input required: capture tradeoffs, surprises, failed approaches, and lessons.",
  ],
  [
    "Limitations",
    "State known limitations, missing evidence, and unresolved questions directly.",
  ],
  [
    "References",
    "List repositories, documentation, related products, and other inspectable sources.",
  ],
] as const;

export interface DraftPreparation {
  report: ValidationReport;
  markdown?: string;
}

export interface DraftOptions {
  output_path?: string;
  title?: string;
}

export async function preparePaperDraft(
  evidencePath: string,
  options: DraftOptions = {},
): Promise<DraftPreparation> {
  const absoluteEvidencePath = resolve(evidencePath);
  let serializedEvidence: string;
  try {
    const metadata = await lstat(absoluteEvidencePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_EVIDENCE_BUNDLE_BYTES
    ) {
      throw new Error("unsupported evidence file");
    }
    serializedEvidence = await readFile(absoluteEvidencePath, "utf8");
  } catch {
    throw new PaperbotError(
      `could not read evidence bundle: ${evidencePath}`,
      ExitCode.io,
    );
  }

  let evidence: unknown;
  try {
    evidence = JSON.parse(serializedEvidence) as unknown;
  } catch {
    return invalidReport(
      "evidence.json_invalid",
      "evidence",
      "evidence bundle is not valid JSON",
    );
  }

  const diagnostics = validateEvidenceValue(evidence);
  sortDiagnostics(diagnostics);
  const valid = diagnostics.every(
    (diagnostic) => diagnostic.severity !== "error",
  );
  if (!valid) {
    return {
      report: {
        schema_version: validation_policy.schema_version,
        valid,
        diagnostics,
      },
    };
  }

  const outputDirectory =
    options.output_path === undefined
      ? process.cwd()
      : dirname(resolve(options.output_path));
  const evidenceReference = relative(outputDirectory, absoluteEvidencePath)
    .split(sep)
    .join("/");
  if (!isSafeRelativePath(evidenceReference)) {
    throw new PaperbotError(
      "draft output must be in the evidence bundle directory or one of its parents",
      ExitCode.usage,
    );
  }

  const bundle = evidence as EvidenceBundle;
  return {
    report: {
      schema_version: validation_policy.schema_version,
      valid,
      diagnostics,
    },
    markdown: renderDraft(bundle, evidenceReference, options.title),
  };
}

export async function writePaperDraft(
  outputPath: string,
  markdown: string,
): Promise<string> {
  const absoluteOutputPath = resolve(outputPath);
  try {
    await writeFile(absoluteOutputPath, markdown, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    const message = isFileExistsError(error)
      ? `refusing to overwrite draft output: ${outputPath}`
      : `could not write draft output: ${outputPath}`;
    throw new PaperbotError(message, ExitCode.io);
  }
  return absoluteOutputPath;
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function renderDraft(
  evidence: EvidenceBundle,
  evidenceReference: string,
  title?: string,
): string {
  const frontMatter = [
    'schema_version: "1"',
    `title: ${JSON.stringify(title ?? "")}`,
    'summary: ""',
    "authors: []",
    'status: "concept"',
    "topics: []",
    `evidence_bundle: ${JSON.stringify(evidenceReference)}`,
  ].join("\n");
  const sections = SECTION_PROMPTS.map(
    ([section, prompt]) => `# ${section}\n\n<!-- ${prompt} -->`,
  ).join("\n\n");
  const evidenceSummary = `<!-- Draft scaffold: ${evidence.sources.length} indexed sources, ${evidence.claims.length} existing claims. The drafting agent must preserve provenance states and ask the author about intention. -->`;

  return `---\n${frontMatter}\n---\n\n${evidenceSummary}\n\n${sections}\n`;
}

function invalidReport(
  code: string,
  path: string,
  message: string,
): DraftPreparation {
  return {
    report: {
      schema_version: validation_policy.schema_version,
      valid: false,
      diagnostics: [
        {
          severity: "error",
          code,
          path,
          message,
        },
      ],
    },
  };
}
