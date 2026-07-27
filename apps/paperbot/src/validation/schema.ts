import type { Diagnostic } from "@prodxiv/contracts/validation";
import Ajv2020, { type AnySchema, type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import evidenceSchema from "../../../../schemas/evidence.schema.json";
import paperSchema from "../../../../schemas/paper.schema.json";
import { diagnostic } from "./shared.ts";

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strict: true,
});
addFormats(ajv);
ajv.addFormat("uint32", {
  type: "number",
  validate: (value: number) =>
    Number.isInteger(value) && value >= 0 && value <= 4_294_967_295,
});

const validatePaperSchema = ajv.compile(paperSchema as AnySchema);
const validateEvidenceSchema = ajv.compile(evidenceSchema as AnySchema);

export function validatePaperStructure(value: unknown): Diagnostic[] {
  return validatePaperSchema(value)
    ? []
    : schemaDiagnostics(validatePaperSchema.errors, "paper");
}

export function validateEvidenceStructure(value: unknown): Diagnostic[] {
  return validateEvidenceSchema(value)
    ? []
    : schemaDiagnostics(validateEvidenceSchema.errors, "evidence");
}

function schemaDiagnostics(
  errors: ErrorObject[] | null | undefined,
  root: string,
): Diagnostic[] {
  return (errors ?? []).map((error) => {
    let path = jsonPointerPath(root, error.instancePath);
    if (error.keyword === "required") {
      const missingProperty = error.params.missingProperty;
      if (typeof missingProperty === "string") {
        path = appendPath(path, missingProperty);
      }
    }
    if (error.keyword === "additionalProperties") {
      const additionalProperty = error.params.additionalProperty;
      if (typeof additionalProperty === "string") {
        path = appendPath(path, additionalProperty);
      }
    }
    return diagnostic(
      `schema.${error.keyword}`,
      path,
      error.message ?? "value does not match the canonical schema",
    );
  });
}

function jsonPointerPath(root: string, pointer: string): string {
  const segments = pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  return segments.reduce(
    (path, segment) =>
      /^\d+$/.test(segment) ? `${path}[${segment}]` : appendPath(path, segment),
    root,
  );
}

function appendPath(path: string, field: string): string {
  return path.length === 0 ? field : `${path}.${field}`;
}
