import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validation_policy } from "@prodxiv/contracts/validation-policy";
import type { ValidationReport } from "@prodxiv/contracts/validation";

import { ExitCode, PaperbotError } from "./errors.ts";
import { type ScanManifest, validateScanManifest } from "./scan-manifest.ts";
import { sortDiagnostics } from "./validation/shared.ts";

const MAX_SCAN_MANIFEST_BYTES = 5 * 1024 * 1024;

const SECTION_PROMPTS = [
  [
    "Summary",
    "Summarize what the product is and who it serves. Leave uncertain details for author review.",
  ],
  [
    "Background",
    "Describe documented context, then ask the author about missing history.",
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
    "Describe observed product behavior and ask the author to confirm intended positioning.",
  ],
  [
    "Architecture",
    "Explain observed architecture, dependencies, and boundaries without inventing design intent.",
  ],
  [
    "Benchmarks",
    "Do not invent results. Record reproducible methodology or state that no benchmark results were found.",
  ],
  [
    "Insights and Lessons",
    "Author input required: capture tradeoffs, surprises, failed approaches, and lessons.",
  ],
  ["Limitations", "State known limitations and unresolved questions directly."],
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
  scanPath: string,
  options: DraftOptions = {},
): Promise<DraftPreparation> {
  const absoluteScanPath = resolve(scanPath);
  let serializedScan: string;
  try {
    const metadata = await lstat(absoluteScanPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_SCAN_MANIFEST_BYTES
    ) {
      throw new Error("unsupported scan manifest");
    }
    serializedScan = await readFile(absoluteScanPath, "utf8");
  } catch {
    throw new PaperbotError(
      `could not read scan manifest: ${scanPath}`,
      ExitCode.io,
    );
  }

  let scan: unknown;
  try {
    scan = JSON.parse(serializedScan) as unknown;
  } catch {
    return invalidReport(
      "scan_manifest.json_invalid",
      "scan_manifest",
      "scan manifest is not valid JSON",
    );
  }

  const { diagnostics, manifest } = validateScanManifest(scan);
  sortDiagnostics(diagnostics);
  const valid = diagnostics.every(
    (diagnostic) => diagnostic.severity !== "error",
  );
  if (!valid || manifest === undefined) {
    return {
      report: {
        schema_version: validation_policy.schema_version,
        valid,
        diagnostics,
      },
    };
  }

  return {
    report: {
      schema_version: validation_policy.schema_version,
      valid,
      diagnostics,
    },
    markdown: renderDraft(manifest, options.title),
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

function renderDraft(scan: ScanManifest, title?: string): string {
  const frontMatter = [
    'schema_version: "1"',
    `title: ${JSON.stringify(title ?? "")}`,
    'summary: ""',
    "authors: []",
    'status: "concept"',
    "topics: []",
  ].join("\n");
  const sections = SECTION_PROMPTS.map(
    ([section, prompt]) => `# ${section}\n\n<!-- ${prompt} -->`,
  ).join("\n\n");
  const scanSummary = `<!-- Draft scaffold from ${scan.files.length} selected repository files at revision ${scan.repository.revision}. Ask the author about intention, tradeoffs, history, and lessons. -->`;

  return `---\n${frontMatter}\n---\n\n${scanSummary}\n\n${sections}\n`;
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
