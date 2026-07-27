import { isAbsolute } from "node:path";

import type { Diagnostic } from "@prodxiv/contracts/validation";

export function diagnostic(
  code: string,
  path: string,
  message: string,
): Diagnostic {
  return {
    severity: "error",
    code,
    path,
    message,
  };
}

export function sortDiagnostics(diagnostics: Diagnostic[]): void {
  diagnostics.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.code.localeCompare(right.code) ||
      left.message.localeCompare(right.message),
  );
}

export function isSafeRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value)
  ) {
    return false;
  }
  return !value
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => segment === "..");
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
