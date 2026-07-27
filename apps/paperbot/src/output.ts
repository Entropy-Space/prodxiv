import type { ScanResult, SkipReason } from "./scanner.ts";
import type { PaperValidationResult } from "./validator.ts";

const SKIP_REASONS: SkipReason[] = [
  "excluded",
  "generated",
  "binary",
  "oversized",
  "symlink",
  "unsupported",
];

export function formatScanResult(result: ScanResult): string {
  const { bundle } = result;
  const sourceCounts = new Map<string, number>();
  for (const source of bundle.sources) {
    sourceCounts.set(
      source.source_type,
      (sourceCounts.get(source.source_type) ?? 0) + 1,
    );
  }

  const sourceSummary =
    [...sourceCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, count]) => `  ${type}: ${count}`)
      .join("\n") || "  none";
  const skipSummary = SKIP_REASONS.map(
    (reason) => `  ${reason}: ${result.skipped_file_counts[reason]}`,
  ).join("\n");

  return [
    "Paperbot repository scan",
    `Repository: ${result.repository_path}`,
    `Revision: ${bundle.repository.revision}`,
    `Working tree: ${bundle.repository.is_dirty ? "dirty" : "clean"}`,
    `Files discovered: ${result.discovered_file_count}`,
    `Evidence sources: ${bundle.sources.length}`,
    "Source types:",
    sourceSummary,
    "Skipped files:",
    skipSummary,
    "Claims: 0 (scan only; drafting adds claims)",
  ].join("\n");
}

export function formatValidationResult(result: PaperValidationResult): string {
  const { report } = result;
  const diagnostics =
    report.diagnostics.length === 0
      ? ["  none"]
      : report.diagnostics.map(
          (item) =>
            `  [${item.severity}] ${item.code} ${item.path}: ${item.message}`,
        );
  return [
    `Paperbot validation: ${report.valid ? "valid" : "invalid"}`,
    `Input: ${result.input_path}`,
    `Profile: ${result.profile}`,
    "Diagnostics:",
    ...diagnostics,
  ].join("\n");
}
