import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { PaperDocument } from "@prodxiv/contracts/paper";
import { validation_policy } from "@prodxiv/contracts/validation-policy";
import type { Diagnostic } from "@prodxiv/contracts/validation";

import { validateEvidenceStructure } from "./schema.ts";
import {
  diagnostic,
  isHttpUrl,
  isRecord,
  isSafeRelativePath,
} from "./shared.ts";

const MAX_EVIDENCE_BUNDLE_BYTES = 5 * 1024 * 1024;

export async function validateReferencedEvidence(
  paper: PaperDocument,
  paperPath: string,
  diagnostics: Diagnostic[],
): Promise<void> {
  const metadata: unknown = paper.metadata;
  if (!isRecord(metadata) || typeof metadata.evidence_bundle !== "string") {
    return;
  }
  const reference = metadata.evidence_bundle;
  if (!isSafeRelativePath(reference)) {
    return;
  }

  const evidencePath = resolve(dirname(paperPath), reference);
  try {
    const metadata = await lstat(evidencePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_EVIDENCE_BUNDLE_BYTES
    ) {
      throw new Error("unsupported evidence file");
    }
  } catch {
    diagnostics.push(
      diagnostic(
        "evidence.file_unreadable",
        "metadata.evidence_bundle",
        "referenced evidence bundle is not a readable regular file",
      ),
    );
    return;
  }

  let evidence: unknown;
  try {
    evidence = JSON.parse(await readFile(evidencePath, "utf8")) as unknown;
  } catch {
    diagnostics.push(
      diagnostic(
        "evidence.json_invalid",
        "metadata.evidence_bundle",
        "referenced evidence bundle is not valid JSON",
      ),
    );
    return;
  }

  diagnostics.push(...validateEvidenceStructure(evidence));
  validateEvidenceRules(evidence, diagnostics);
}

function validateEvidenceRules(
  value: unknown,
  diagnostics: Diagnostic[],
): void {
  if (!isRecord(value)) {
    return;
  }
  const sources = Array.isArray(value.sources) ? value.sources : [];
  validateRepository(value.repository, diagnostics);
  const sourceIds = validateSources(sources, diagnostics);
  const claims = Array.isArray(value.claims) ? value.claims : [];
  validateClaims(claims, sourceIds, diagnostics);
}

function validateRepository(value: unknown, diagnostics: Diagnostic[]): void {
  if (
    isRecord(value) &&
    typeof value.source_url === "string" &&
    !isHttpUrl(value.source_url)
  ) {
    diagnostics.push(
      diagnostic(
        "value.invalid_url",
        "evidence.repository.source_url",
        "URL must be an absolute HTTP or HTTPS URL",
      ),
    );
  }
}

function validateSources(
  sources: unknown[],
  diagnostics: Diagnostic[],
): Set<string> {
  const sourceIds = new Set<string>();
  sources.forEach((source, index) => {
    if (!isRecord(source)) {
      return;
    }
    if (typeof source.source_id === "string") {
      if (sourceIds.has(source.source_id)) {
        diagnostics.push(
          diagnostic(
            "evidence.duplicate_source_id",
            `evidence.sources[${index}].source_id`,
            "source identifiers must be unique",
          ),
        );
      }
      sourceIds.add(source.source_id);
    }
    if (typeof source.path === "string" && !isSafeRelativePath(source.path)) {
      diagnostics.push(
        diagnostic(
          "evidence.invalid_path",
          `evidence.sources[${index}].path`,
          "evidence paths must be non-empty, repository-relative paths",
        ),
      );
    }
  });
  return sourceIds;
}

function validateClaims(
  claims: unknown[],
  sourceIds: Set<string>,
  diagnostics: Diagnostic[],
): void {
  const claimIds = new Set<string>();
  claims.forEach((claim, claimIndex) => {
    if (!isRecord(claim)) {
      return;
    }
    validateClaimId(claim, claimIndex, claimIds, diagnostics);
    const locations = Array.isArray(claim.locations) ? claim.locations : [];
    if (
      validation_policy.evidence.verified_claims_require_locations &&
      claim.provenance_state === "verified" &&
      locations.length === 0
    ) {
      diagnostics.push(
        diagnostic(
          "evidence.verified_requires_location",
          `evidence.claims[${claimIndex}].locations`,
          "verified claims require at least one evidence location",
        ),
      );
    }
    locations.forEach((location, locationIndex) =>
      validateLocation(
        location,
        claimIndex,
        locationIndex,
        sourceIds,
        diagnostics,
      ),
    );
  });
}

function validateClaimId(
  claim: Record<string, unknown>,
  claimIndex: number,
  claimIds: Set<string>,
  diagnostics: Diagnostic[],
): void {
  if (typeof claim.claim_id !== "string") {
    return;
  }
  if (claimIds.has(claim.claim_id)) {
    diagnostics.push(
      diagnostic(
        "evidence.duplicate_claim_id",
        `evidence.claims[${claimIndex}].claim_id`,
        "claim identifiers must be unique",
      ),
    );
  }
  claimIds.add(claim.claim_id);
}

function validateLocation(
  value: unknown,
  claimIndex: number,
  locationIndex: number,
  sourceIds: Set<string>,
  diagnostics: Diagnostic[],
): void {
  if (!isRecord(value)) {
    return;
  }
  const base = `evidence.claims[${claimIndex}].locations[${locationIndex}]`;
  if (typeof value.source_id === "string" && !sourceIds.has(value.source_id)) {
    diagnostics.push(
      diagnostic(
        "evidence.unknown_source",
        `${base}.source_id`,
        "evidence location references an unknown source",
      ),
    );
  }
  if (value.line_start == null && value.line_end != null) {
    diagnostics.push(
      diagnostic(
        "evidence.line_start_required",
        `${base}.line_start`,
        "line_start is required when line_end is present",
      ),
    );
  }
  if (
    typeof value.line_start === "number" &&
    typeof value.line_end === "number" &&
    value.line_end < value.line_start
  ) {
    diagnostics.push(
      diagnostic(
        "evidence.invalid_line_range",
        base,
        "line_end must be greater than or equal to line_start",
      ),
    );
  }
}
