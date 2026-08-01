import type { Diagnostic } from "@prodxiv/contracts/validation";

import {
  diagnostic,
  isRecord,
  isSafeRelativePath,
} from "./validation/shared.ts";

export type ScanFileType =
  | "source_code"
  | "documentation"
  | "test"
  | "benchmark"
  | "configuration"
  | "manifest";

export interface RepositorySnapshot {
  source_url?: string;
  revision: string;
  is_dirty: boolean;
}

export interface ScannedFile {
  path: string;
  file_type: ScanFileType;
}

export interface ScanManifest {
  schema_version: "1";
  repository: RepositorySnapshot;
  files: ScannedFile[];
}

const FILE_TYPES = new Set<ScanFileType>([
  "source_code",
  "documentation",
  "test",
  "benchmark",
  "configuration",
  "manifest",
]);

export function validateScanManifest(value: unknown): {
  manifest?: ScanManifest;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(value)) {
    return invalid("scan manifest must be a JSON object");
  }
  if (value.schema_version !== "1") {
    diagnostics.push(
      diagnostic(
        "scan_manifest.unsupported_schema",
        "scan_manifest.schema_version",
        "scan manifest schema_version must be 1",
      ),
    );
  }
  if (!isRepositorySnapshot(value.repository)) {
    diagnostics.push(
      diagnostic(
        "scan_manifest.invalid_repository",
        "scan_manifest.repository",
        "scan manifest repository metadata is invalid",
      ),
    );
  }
  if (!Array.isArray(value.files)) {
    diagnostics.push(
      diagnostic(
        "scan_manifest.invalid_files",
        "scan_manifest.files",
        "scan manifest files must be an array",
      ),
    );
  } else {
    for (const [index, file] of value.files.entries()) {
      if (!isScannedFile(file)) {
        diagnostics.push(
          diagnostic(
            "scan_manifest.invalid_file",
            `scan_manifest.files[${index}]`,
            "scanned files require a safe path and recognized file_type",
          ),
        );
      }
    }
  }

  return diagnostics.length === 0
    ? { manifest: value as unknown as ScanManifest, diagnostics }
    : { diagnostics };
}

function invalid(message: string): { diagnostics: Diagnostic[] } {
  return {
    diagnostics: [
      diagnostic("scan_manifest.invalid", "scan_manifest", message),
    ],
  };
}

function isRepositorySnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.revision === "string" &&
    value.revision.length > 0 &&
    typeof value.is_dirty === "boolean" &&
    (value.source_url === undefined || typeof value.source_url === "string")
  );
}

function isScannedFile(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    isSafeRelativePath(value.path) &&
    typeof value.file_type === "string" &&
    FILE_TYPES.has(value.file_type as ScanFileType)
  );
}
