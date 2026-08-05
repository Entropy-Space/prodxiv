import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { validation_policy } from "@prodxiv/contracts/validation-policy";
import { validatePaperFile } from "@prodxiv/paperbot-core";

import { parseArguments } from "../src/arguments.ts";
import { run } from "../src/cli.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const fixtureRoot = resolve(import.meta.dir, "fixtures/validation");

describe("validatePaperFile", () => {
  test("accepts the exemplary paper under the publication profile", async () => {
    const result = await validatePaperFile(
      resolve(repositoryRoot, "examples/papers/prodxiv.md"),
      "publication",
    );

    expect(result.report).toEqual({
      schema_version: "2",
      valid: true,
      diagnostics: [],
    });
  });

  test("validates a complete draft", async () => {
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
      "publication.revision_required",
    ]);
  });

  test("matches authoritative submission metadata rules", async () => {
    const temporaryDirectory = await mkdtemp(
      resolve(tmpdir(), "paperbot-submission-"),
    );
    const paperPath = resolve(temporaryDirectory, "paper.md");
    const publishedSource = await readFile(
      resolve(repositoryRoot, "examples/papers/prodxiv.md"),
      "utf8",
    );
    await writeFile(paperPath, publishedSource);

    try {
      const published = await validatePaperFile(paperPath, "submission");
      expect(codes(published)).toEqual([
        "submission.paper_id_forbidden",
        "submission.date_forbidden",
        "submission.version_forbidden",
      ]);

      await writeFile(
        paperPath,
        publishedSource
          .replace(/^paper_id:.*\n/m, "")
          .replace(/^published_at:.*\n/m, "")
          .replace(/^version:.*\n/m, ""),
      );
      expect(
        (await validatePaperFile(paperPath, "submission")).report.valid,
      ).toBe(true);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
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
      .replace("topics:", 'published_at: "2026-02-30"\ntopics:');
    await writeFile(paperPath, source);

    try {
      const result = await validatePaperFile(paperPath, "draft");
      expect(codes(result)).toContain("value.required");
      expect(codes(result)).toContain("publication.invalid_date");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("enforces v2 writer contact and inferred-status rules", async () => {
    const temporaryDirectory = await mkdtemp(
      resolve(tmpdir(), "paperbot-v2-metadata-"),
    );
    const paperPath = resolve(temporaryDirectory, "paper.md");
    const source = (
      await readFile(resolve(fixtureRoot, "valid-paper.md"), "utf8")
    )
      .replace(
        '  - kind: "human"\n    name: "Fixture writer"',
        '  - kind: "agent"\n    name: "paperbot"\n    model: "fixture-model"',
      )
      .replace('  determination: "declared"', '  determination: "inferred"');
    await writeFile(paperPath, source);

    try {
      const result = await validatePaperFile(paperPath, "draft");
      expect(codes(result)).toContain(
        "communication_email.human_writer_required",
      );
      expect(codes(result)).toContain("status.inferred_evidence_required");
      expect(codes(result)).toContain("status.inferred_observed_at_required");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("rejects an impossible inferred-status observation date", async () => {
    const temporaryDirectory = await mkdtemp(
      resolve(tmpdir(), "paperbot-v2-status-date-"),
    );
    const paperPath = resolve(temporaryDirectory, "paper.md");
    const source = (
      await readFile(resolve(fixtureRoot, "valid-paper.md"), "utf8")
    ).replace(
      '  determination: "declared"\n  confidence: "high"',
      [
        '  determination: "inferred"',
        '  confidence: "high"',
        '  observed_at: "2026-02-31T00:00:00Z"',
        "  evidence:",
        '    - kind: "github_release"',
        '      url: "https://github.com/example/product/releases/tag/v1.0.0"',
        '      tag: "v1.0.0"',
      ].join("\n"),
    );
    await writeFile(paperPath, source);

    try {
      const result = await validatePaperFile(paperPath, "draft");
      expect(codes(result)).toContain("status.invalid_observed_at");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("keeps legacy papers readable but rejects new v1 submissions", async () => {
    const temporaryDirectory = await mkdtemp(
      resolve(tmpdir(), "paperbot-v1-submission-"),
    );
    const paperPath = resolve(temporaryDirectory, "paper.md");
    const source = (
      await readFile(resolve(fixtureRoot, "valid-paper.md"), "utf8")
    )
      .replace('schema_version: "2"', 'schema_version: "1"')
      .replace(
        '  - kind: "person"\n    name: "Fixture author"',
        '  - name: "Fixture author"',
      )
      .replace(
        'writers:\n  - kind: "human"\n    name: "Fixture writer"\ncommunication_email: "fixture@example.test"\n',
        "",
      )
      .replace(
        'status:\n  value: "concept"\n  determination: "declared"\n  confidence: "high"',
        'status: "concept"',
      )
      .replace("topics:", 'license: "CC BY 4.0"\ntopics:');
    await writeFile(paperPath, source);

    try {
      expect((await validatePaperFile(paperPath, "draft")).report.valid).toBe(
        true,
      );
      expect(codes(await validatePaperFile(paperPath, "submission"))).toContain(
        "submission.current_schema_required",
      );
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
      "Insights and Lessons",
      "Limitations",
      "References",
    ]);
  });
});

describe("paper_validate tool", () => {
  test("parses the publication profile and JSON format", () => {
    expect(
      parseArguments([
        "tools",
        "paper_validate",
        "paper.md",
        "--profile=publication",
        "--format",
        "json",
      ]),
    ).toEqual({
      command: "tools",
      action: "paper_validate",
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
        "tools",
        "paper_validate",
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
        schema_version: "2",
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
