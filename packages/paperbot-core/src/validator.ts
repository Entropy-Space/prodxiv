import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validation_policy } from "@prodxiv/contracts/validation-policy";
import type {
  Diagnostic,
  ValidationReport,
} from "@prodxiv/contracts/validation";

import { ExitCode, PaperbotError } from "./errors.ts";
import { parsePaper, validatePaperRules } from "./validation/paper.ts";
import type { ValidationProfile } from "./validation/profile.ts";
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

  return validatePaperSource(source, absoluteInputPath, profile);
}

export function validatePaperSource(
  source: string,
  inputPath: string,
  profile: ValidationProfile,
): PaperValidationResult {
  const diagnostics: Diagnostic[] = [];
  const paper = parsePaper(source, diagnostics);
  if (paper !== undefined) {
    diagnostics.push(...validatePaperStructure(paper));
    validatePaperRules(paper, profile, diagnostics);
  }

  sortDiagnostics(diagnostics);
  return {
    input_path: inputPath,
    profile,
    report: {
      schema_version: validation_policy.schema_version,
      valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
      diagnostics,
    },
  };
}
