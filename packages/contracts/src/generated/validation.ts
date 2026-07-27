/* Generated from the canonical Rust contract. Do not edit manually. */

export type DiagnosticSeverity = "error" | "warning";

export interface ValidationReport {
  diagnostics: Diagnostic[];
  schema_version: string;
  valid: boolean;
}
export interface Diagnostic {
  code: string;
  message: string;
  path: string;
  severity: DiagnosticSeverity;
}
