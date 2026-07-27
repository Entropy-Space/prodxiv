import type { PaperMetadata } from "@prodxiv/contracts/paper";
import { validation_policy } from "@prodxiv/contracts/validation-policy";
import Ajv2020, {
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "astro/zod";

import paperSchema from "../../../../schemas/paper.schema.json";

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

const metadataSchema = {
  $schema: paperSchema.$schema,
  $ref: "#/$defs/PaperMetadata",
  $defs: paperSchema.$defs,
};
const validateMetadata = ajv.compile<PaperMetadata>(
  metadataSchema as AnySchema,
);

type PublicationField =
  (typeof validation_policy.paper.publication_required_metadata)[number];
type PublishedPaperMetadata = PaperMetadata & {
  [Field in PublicationField]-?: NonNullable<PaperMetadata[Field]>;
};

export const paperMetadataSchema = canonicalSchema(validateMetadata)
  .superRefine((value, context) => {
    for (const field of validation_policy.paper.publication_required_metadata) {
      if (value[field] === undefined || value[field] === null) {
        context.addIssue({
          code: "custom",
          message: "is required for a published paper",
          path: [field],
        });
      }
    }
  })
  .transform((value) => value as PublishedPaperMetadata);

function canonicalSchema<Value>(validate: ValidateFunction<Value>) {
  return z
    .unknown()
    .superRefine((value, context) => {
      if (validate(value)) {
        return;
      }
      for (const error of validate.errors ?? []) {
        context.addIssue({
          code: "custom",
          message: error.message ?? "does not match the canonical JSON Schema",
          path: errorPath(error),
        });
      }
    })
    .transform((value) => value as Value);
}

function errorPath(error: ErrorObject): Array<string | number> {
  const path = error.instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));

  if (error.keyword === "required") {
    const missingProperty: unknown = error.params.missingProperty;
    if (typeof missingProperty === "string") {
      path.push(missingProperty);
    }
  }
  if (error.keyword === "additionalProperties") {
    const additionalProperty: unknown = error.params.additionalProperty;
    if (typeof additionalProperty === "string") {
      path.push(additionalProperty);
    }
  }

  return path;
}
