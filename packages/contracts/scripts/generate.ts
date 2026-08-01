import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { compileFromFile } from "json-schema-to-typescript";
import { format } from "prettier";

const packageRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const outputDirectory = join(packageRoot, "src/generated");

const contracts = [
  ["paper.schema.json", "paper.ts"],
  ["validation.schema.json", "validation.ts"],
] as const;

await mkdir(outputDirectory, { recursive: true });

for (const [schemaFilename, outputFilename] of contracts) {
  const compiled = await compileFromFile(
    join(repositoryRoot, "schemas", schemaFilename),
    {
      bannerComment:
        "/* Generated from the canonical Rust contract. Do not edit manually. */",
      format: false,
    },
  );
  const generated = await format(compiled, {
    parser: "typescript",
    printWidth: 80,
    semi: true,
    singleQuote: false,
    tabWidth: 2,
    trailingComma: "all",
    useTabs: false,
  });

  await writeFile(join(outputDirectory, outputFilename), generated);
}

await writeFile(
  join(outputDirectory, "paper.schema.json"),
  await format(
    await readFile(
      join(repositoryRoot, "schemas", "paper.schema.json"),
      "utf8",
    ),
    {
      parser: "json",
      printWidth: 80,
      tabWidth: 2,
      useTabs: false,
    },
  ),
);

const validationPolicy = JSON.parse(
  await readFile(
    join(repositoryRoot, "schemas", "validation-policy.json"),
    "utf8",
  ),
) as unknown;
const generatedPolicy = await format(
  `/* Generated from the canonical Rust validation policy. Do not edit manually. */

export const validation_policy = ${JSON.stringify(validationPolicy)} as const;
export type ValidationPolicy = typeof validation_policy;
`,
  {
    parser: "typescript",
    printWidth: 80,
    semi: true,
    singleQuote: false,
    tabWidth: 2,
    trailingComma: "all",
    useTabs: false,
  },
);
await writeFile(join(outputDirectory, "validation-policy.ts"), generatedPolicy);
