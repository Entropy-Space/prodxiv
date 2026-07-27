import { expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { parseArguments } from "../src/arguments.ts";
import { preparePaperDraft, writePaperDraft } from "../src/drafter.ts";
import { PaperbotError } from "../src/errors.ts";
import { validatePaperFile } from "../src/validator.ts";

const fixtureRoot = resolve(import.meta.dir, "fixtures/validation");

test("parses deterministic draft arguments", () => {
  expect(
    parseArguments([
      "draft",
      "scan.json",
      "--title",
      "Fixture",
      "--output=paper.md",
    ]),
  ).toEqual({
    command: "draft",
    scan_path: "scan.json",
    title: "Fixture",
    output_path: "paper.md",
  });
});

test("creates a complete scaffold from a scan manifest", async () => {
  const result = await preparePaperDraft(
    resolve(fixtureRoot, "valid-scan.json"),
    { title: "Fixture product" },
  );

  expect(result.report.valid).toBe(true);
  expect(result.markdown).toContain('title: "Fixture product"');
  expect(result.markdown).toContain("# Summary");
  expect(result.markdown).toContain("# Architecture");
  expect(result.markdown).toContain("# Limitations");
  expect(result.markdown).toContain("# References");
  expect(result.markdown).toContain(
    "Draft scaffold from 1 selected repository files",
  );
});

test("refuses an invalid scan manifest before drafting", async () => {
  const result = await preparePaperDraft(
    resolve(fixtureRoot, "invalid-scan.json"),
  );

  expect(result.report.valid).toBe(false);
  expect(result.markdown).toBeUndefined();
  expect(result.report.diagnostics.map((item) => item.code)).toContain(
    "scan_manifest.invalid_file",
  );
});

test("writes once, preserves existing work, and remains visibly incomplete", async () => {
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "paperbot-draft-"),
  );
  const scanPath = resolve(temporaryDirectory, "scan.json");
  const paperPath = resolve(temporaryDirectory, "paper.md");
  await copyFile(resolve(fixtureRoot, "valid-scan.json"), scanPath);

  try {
    const result = await preparePaperDraft(scanPath, {
      output_path: paperPath,
      title: "Fixture product",
    });
    expect(result.report.valid).toBe(true);
    expect(result.markdown).toBeDefined();
    await writePaperDraft(paperPath, result.markdown ?? "");

    const firstDraft = await readFile(paperPath, "utf8");
    expect(firstDraft).not.toContain("scan.json");
    await expect(writePaperDraft(paperPath, "replacement")).rejects.toEqual(
      expect.objectContaining({
        exit_code: 4,
      } satisfies Partial<PaperbotError>),
    );
    expect(await readFile(paperPath, "utf8")).toBe(firstDraft);

    const validation = await validatePaperFile(paperPath, "draft");
    expect(validation.report.valid).toBe(false);
    expect(validation.report.diagnostics.map((item) => item.path)).toContain(
      "paper.metadata.summary",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
