import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { EvidenceBundle } from "@prodxiv/contracts/evidence";

import { preparePaperDraft } from "../src/drafter.ts";
import { scanRepository } from "../src/scanner.ts";
import { validatePaperFile } from "../src/validator.ts";

const repositoryFixture = resolve(import.meta.dir, "fixtures/repository");
const paperFixture = resolve(
  import.meta.dir,
  "../../../examples/papers/paperbot-fixture.md",
);
const evidenceFixture = resolve(
  import.meta.dir,
  "../../../examples/papers/evidence/paperbot-fixture.json",
);

let workspacePath = "";
let repositoryPath = "";

beforeEach(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), "paperbot-workflow-"));
  repositoryPath = join(workspacePath, "repository");
  await cp(repositoryFixture, repositoryPath, { recursive: true });
  await git(["init", "-q"]);
  await git(["config", "user.email", "paperbot@example.test"]);
  await git(["config", "user.name", "Paperbot Fixture"]);
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "fixture"]);
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

describe("repository-to-renderable-paper workflow", () => {
  test("scans, scaffolds, completes, and validates a paper", async () => {
    const referenceEvidence = JSON.parse(
      await readFile(evidenceFixture, "utf8"),
    ) as EvidenceBundle;
    const scan = await scanRepository(repositoryPath, {
      exclusions: [".gitignore", "docs/private.md"],
    });
    expect(scan.bundle.sources).toHaveLength(referenceEvidence.sources.length);
    expect(
      scan.bundle.sources.map(({ source_id, path, content_sha256 }) => ({
        source_id,
        path,
        content_sha256,
      })),
    ).toEqual(
      expect.arrayContaining(
        referenceEvidence.sources.map(
          ({ source_id, path, content_sha256 }) => ({
            source_id,
            path,
            content_sha256,
          }),
        ),
      ),
    );

    const evidencePath = join(workspacePath, "evidence.json");
    await writeFile(evidencePath, `${JSON.stringify(scan.bundle, null, 2)}\n`);

    const scaffold = await preparePaperDraft(evidencePath, {
      output_path: join(workspacePath, "paper.md"),
      title: "Paperbot Fixture",
    });
    expect(scaffold.report.valid).toBe(true);
    expect(scaffold.markdown).toContain('evidence_bundle: "evidence.json"');
    expect(scaffold.markdown).toContain("# Insights and Lessons");

    const completedEvidence: EvidenceBundle = {
      ...scan.bundle,
      claims: referenceEvidence.claims,
    };
    await writeFile(
      evidencePath,
      `${JSON.stringify(completedEvidence, null, 2)}\n`,
    );

    const completedPaperPath = join(workspacePath, "paper.md");
    const completedPaper = (await readFile(paperFixture, "utf8")).replace(
      'evidence_bundle: "evidence/paperbot-fixture.json"',
      'evidence_bundle: "evidence.json"',
    );
    await writeFile(completedPaperPath, completedPaper);

    const validation = await validatePaperFile(
      completedPaperPath,
      "publication",
    );
    expect(validation.report).toEqual({
      schema_version: "1",
      valid: true,
      diagnostics: [],
    });
  });

  test("keeps checked-in evidence hashes tied to fixture contents", async () => {
    const evidence = JSON.parse(
      await readFile(evidenceFixture, "utf8"),
    ) as EvidenceBundle;

    for (const source of evidence.sources) {
      const content = await readFile(join(repositoryFixture, source.path));
      expect(createHash("sha256").update(content).digest("hex")).toBe(
        source.content_sha256,
      );
    }
  });
});

async function git(args: string[]): Promise<void> {
  const process = Bun.spawn(["git", "-C", repositoryPath, ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}
