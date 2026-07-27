import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { validation_policy } from "@prodxiv/contracts/validation-policy";

import { parseArguments } from "../src/arguments.ts";
import { run } from "../src/cli.ts";
import { validatePaperFile } from "../src/validator.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const fixtureRoot = resolve(import.meta.dir, "fixtures/validation");

describe("validatePaperFile", () => {
  test("accepts the exemplary paper under the publication profile", async () => {
    const result = await validatePaperFile(
      resolve(repositoryRoot, "examples/papers/prodxiv.md"),
      "publication",
    );

    expect(result.report).toEqual({
      schema_version: "1",
      valid: true,
      diagnostics: [],
    });
  });

  test("validates a draft and its referenced evidence bundle", async () => {
    const result = await validatePaperFile(
      resolve(fixtureRoot, "valid-paper.md"),
      "draft",
    );

    expect(result.report.valid).toBe(true);
    expect(result.report.diagnostics).toEqual([]);
  });

  test("requires archive-owned metadata only for publication", async () => {
    const paperPath = resolve(fixtureRoot, "valid-paper.md");

    expect((await validatePaperFile(paperPath, "draft")).report.valid).toBe(
      true,
    );
    const publication = await validatePaperFile(paperPath, "publication");

    expect(publication.report.valid).toBe(false);
    expect(codes(publication)).toEqual([
      "publication.license_required",
      "publication.paper_id_required",
      "publication.date_required",
      "publication.version_required",
    ]);
  });

  test("matches authoritative evidence cross-reference diagnostics", async () => {
    const result = await validatePaperFile(
      resolve(fixtureRoot, "paper-with-invalid-evidence.md"),
      "draft",
    );

    expect(result.report.valid).toBe(false);
    expect(codes(result)).toContain("evidence.unknown_source");
    expect(codes(result)).toContain("evidence.invalid_line_range");
  });

  test("matches authoritative missing-section diagnostics", async () => {
    const result = await validatePaperFile(
      resolve(
        repositoryRoot,
        "crates/prodxiv-domain/tests/fixtures/missing-sections.md",
      ),
      "draft",
    );

    expect(result.report.valid).toBe(false);
    expect(
      codes(result).filter((code) => code === "sections.missing"),
    ).toHaveLength(7);
  });

  test("rejects the shared malformed front matter fixture", async () => {
    const result = await validatePaperFile(
      resolve(
        repositoryRoot,
        "crates/prodxiv-domain/tests/fixtures/malformed-frontmatter.md",
      ),
      "draft",
    );

    expect(result.report.valid).toBe(false);
    expect(codes(result)).toContain("paper.front_matter_invalid");
  });

  test("applies non-schema domain rules to draft metadata", async () => {
    const temporaryDirectory = await mkdtemp(
      resolve(tmpdir(), "paperbot-validate-"),
    );
    const paperPath = resolve(temporaryDirectory, "paper.md");
    const source = (
      await readFile(resolve(fixtureRoot, "valid-paper.md"), "utf8")
    )
      .replace(
        'summary: "A complete draft fixture for Paperbot validation."',
        'summary: "   "',
      )
      .replace(
        'status: "concept"',
        'status: "concept"\npublished_at: "2026-02-30"',
      )
      .replace(
        'evidence_bundle: "valid-evidence.json"',
        'evidence_bundle: "../evidence.json"',
      );
    await writeFile(paperPath, source);

    try {
      const result = await validatePaperFile(paperPath, "draft");
      expect(codes(result)).toContain("value.required");
      expect(codes(result)).toContain("publication.invalid_date");
      expect(codes(result)).toContain("value.invalid_relative_path");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("uses the generated required-section policy", () => {
    expect(validation_policy.paper.required_sections).toEqual([
      "Summary",
      "Background",
      "Motivation",
      "Related Work",
      "Core Features",
      "Benchmarks",
      "Insights and Lessons",
      "Limitations",
    ]);
  });
});

describe("validate CLI", () => {
  test("parses the publication profile and JSON format", () => {
    expect(
      parseArguments([
        "validate",
        "paper.md",
        "--profile=publication",
        "--format",
        "json",
      ]),
    ).toEqual({
      command: "validate",
      input_path: "paper.md",
      profile: "publication",
      format: "json",
    });
  });

  test("writes a versioned report to stdout and returns exit code 5", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await run(
      [
        "validate",
        resolve(fixtureRoot, "valid-paper.md"),
        "--profile",
        "publication",
        "--format",
        "json",
      ],
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
    );

    expect(exitCode).toBe(5);
    expect(stdout).toHaveLength(1);
    const report = JSON.parse(stdout[0] ?? "{}") as {
      schema_version?: string;
      valid?: boolean;
    };
    expect(report).toEqual(
      expect.objectContaining({
        schema_version: "1",
        valid: false,
      }),
    );
    expect(stderr).toEqual([
      expect.stringContaining("paperbot: validation failed"),
    ]);
  });
});

function codes(
  result: Awaited<ReturnType<typeof validatePaperFile>>,
): string[] {
  return result.report.diagnostics.map((item) => item.code);
}
