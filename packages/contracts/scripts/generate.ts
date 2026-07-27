import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { compileFromFile } from "json-schema-to-typescript";
import { format } from "prettier";

const packageRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const outputDirectory = join(packageRoot, "src/generated");

const contracts = [
  ["evidence.schema.json", "evidence.ts"],
  ["paper.schema.json", "paper.ts"],
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
