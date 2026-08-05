import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { preparePaperDraft, validatePaperFile } from "@prodxiv/paperbot-core";
import { scanRepository } from "@prodxiv/paperbot-source";

const repositoryFixture = resolve(import.meta.dir, "fixtures/repository");
const paperFixture = resolve(
  import.meta.dir,
  "../../../examples/papers/paperbot-fixture.md",
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
    const scan = await scanRepository(repositoryPath, {
      exclusions: [".gitignore", "docs/private.md"],
    });
    expect(scan.manifest.files.map((file) => file.path)).toEqual([
      "README.md",
      "benches/latency.ts",
      "config/app.toml",
      "package.json",
      "src/index.ts",
      "src/secret-scanner.ts",
      "tests/index.test.ts",
    ]);

    const scanPath = join(workspacePath, "scan.json");
    await writeFile(scanPath, `${JSON.stringify(scan.manifest, null, 2)}\n`);

    const scaffold = await preparePaperDraft(scanPath, {
      output_path: join(workspacePath, "paper.md"),
      title: "Paperbot Fixture",
    });
    expect(scaffold.report.valid).toBe(true);
    expect(scaffold.markdown).toContain(
      "Draft scaffold from 7 selected repository files",
    );
    expect(scaffold.markdown).toContain("# Insights and Lessons");

    const completedPaperPath = join(workspacePath, "paper.md");
    const completedPaper = await readFile(paperFixture, "utf8");
    await writeFile(completedPaperPath, completedPaper);

    const validation = await validatePaperFile(
      completedPaperPath,
      "publication",
    );
    expect(validation.report).toEqual({
      schema_version: "2",
      valid: true,
      diagnostics: [],
    });
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
