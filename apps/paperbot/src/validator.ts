import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validation_policy } from "@prodxiv/contracts/validation-policy";
import type {
  Diagnostic,
  ValidationReport,
} from "@prodxiv/contracts/validation";

import type { ValidationProfile } from "./arguments.ts";
import { ExitCode, PaperbotError } from "./errors.ts";
import { validateReferencedEvidence } from "./validation/evidence.ts";
import { parsePaper, validatePaperRules } from "./validation/paper.ts";
import { validatePaperStructure } from "./validation/schema.ts";
import { sortDiagnostics } from "./validation/shared.ts";

export interface PaperValidationResult {
  input_path: string;
  profile: ValidationProfile;
  report: ValidationReport;
}

export async function validatePaperFile(
  inputPath: string,
  profile: ValidationProfile,
): Promise<PaperValidationResult> {
  const absoluteInputPath = resolve(inputPath);
  let source: string;
  try {
    source = await readFile(absoluteInputPath, "utf8");
  } catch {
    throw new PaperbotError(`could not read paper: ${inputPath}`, ExitCode.io);
  }

  const diagnostics: Diagnostic[] = [];
  const paper = parsePaper(source, diagnostics);
  if (paper !== undefined) {
    diagnostics.push(...validatePaperStructure(paper));
    validatePaperRules(paper, profile, diagnostics);
    await validateReferencedEvidence(paper, absoluteInputPath, diagnostics);
  }

  sortDiagnostics(diagnostics);
  return {
    input_path: absoluteInputPath,
    profile,
    report: {
      schema_version: validation_policy.schema_version,
      valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
      diagnostics,
    },
  };
}
