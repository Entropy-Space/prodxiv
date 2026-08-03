import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const cliPath = resolve(packageRoot, "src/cli.ts");
const fixturePath = resolve(
  packageRoot,
  "tests/fixtures/validation/valid-paper.md",
);

let temporaryPath = "";

afterEach(async () => {
  if (temporaryPath.length > 0) {
    await rm(temporaryPath, { recursive: true, force: true });
  }
});

test("compiled Paperbot preserves its unified CLI from a clean directory", async () => {
  temporaryPath = await mkdtemp(join(tmpdir(), "paperbot-binary-"));
  const binaryPath = join(
    temporaryPath,
    process.platform === "win32" ? "paperbot.exe" : "paperbot",
  );
  const cleanPath = join(temporaryPath, "clean");
  const homePath = join(temporaryPath, "home");
  const environment = {
    HOME: homePath,
    PATH: process.env.PATH ?? "",
  };
  await Promise.all([mkdir(cleanPath), mkdir(homePath)]);

  const build = await runProcess(
    [
      "bun",
      "build",
      "--compile",
      "--target=bun",
      "--outfile",
      binaryPath,
      cliPath,
    ],
    repositoryRoot,
  );
  expect(build.exit_code).toBe(0);

  const version = await runProcess(
    [binaryPath, "--version"],
    cleanPath,
    environment,
  );
  expect(version).toEqual({ exit_code: 0, stdout: "0.0.1\n", stderr: "" });

  const skills = await runProcess(
    [binaryPath, "skills", "paper", "references", "--format", "json"],
    cleanPath,
    environment,
  );
  expect(skills.exit_code).toBe(0);
  expect(JSON.parse(skills.stdout)).toMatchObject({
    schema_version: "1",
    scope: "paper",
    component: "references",
  });

  const tools = await runProcess(
    [binaryPath, "tools", "list"],
    cleanPath,
    environment,
  );
  expect(tools.exit_code).toBe(0);
  expect(JSON.parse(tools.stdout)).toMatchObject({
    schema_version: "1",
    tools: expect.arrayContaining([
      expect.objectContaining({ name: "repo_scan" }),
      expect.objectContaining({ name: "paper_validate" }),
    ]),
    excluded_commands: ["skills", "auth", "publish"],
  });

  const validation = await runProcess(
    [binaryPath, "validate", fixturePath, "--format", "json"],
    cleanPath,
    environment,
  );
  expect(validation.exit_code).toBe(0);
  expect(JSON.parse(validation.stdout)).toMatchObject({
    schema_version: "1",
    valid: true,
    diagnostics: [],
  });

  const sourcePath = join(temporaryPath, "source-repository");
  await mkdir(sourcePath);
  await Promise.all([
    writeFile(join(sourcePath, "README.md"), "# Compiled Paperbot\n"),
    writeFile(
      join(sourcePath, "package.json"),
      '{"name":"compiled-paperbot-fixture","private":true}\n',
    ),
  ]);
  for (const command of [
    ["git", "init", "-q", sourcePath],
    ["git", "-C", sourcePath, "config", "user.email", "paperbot@example.test"],
    ["git", "-C", sourcePath, "config", "user.name", "Paperbot Fixture"],
    ["git", "-C", sourcePath, "add", "-A"],
    ["git", "-C", sourcePath, "commit", "-q", "-m", "fixture"],
  ]) {
    expect((await runProcess(command, cleanPath, environment)).exit_code).toBe(
      0,
    );
  }

  const scan = await runProcess(
    [binaryPath, "scan", sourcePath, "--format", "json"],
    cleanPath,
    environment,
  );
  expect(scan.exit_code).toBe(0);
  expect(JSON.parse(scan.stdout)).toMatchObject({
    schema_version: "1",
    files: expect.arrayContaining([
      expect.objectContaining({ path: "README.md" }),
      expect.objectContaining({ path: "package.json" }),
    ]),
  });

  const toolScan = await runProcess(
    [binaryPath, "tools", "repo_scan", sourcePath, "--format", "json"],
    cleanPath,
    environment,
  );
  expect(toolScan.exit_code).toBe(0);
  expect(JSON.parse(toolScan.stdout)).toMatchObject({
    schema_version: "1",
    files: expect.arrayContaining([
      expect.objectContaining({ path: "README.md" }),
      expect.objectContaining({ path: "package.json" }),
    ]),
  });

  const scanPath = join(cleanPath, "scan.json");
  const draftPath = join(cleanPath, "draft.md");
  await writeFile(scanPath, scan.stdout);
  const draft = await runProcess(
    [
      binaryPath,
      "draft",
      scanPath,
      "--title",
      "Compiled Paperbot fixture",
      "--output",
      draftPath,
    ],
    cleanPath,
    environment,
  );
  expect(draft.exit_code).toBe(0);
  expect(await readFile(draftPath, "utf8")).toContain("# References");

  const toolDraft = await runProcess(
    [
      binaryPath,
      "tools",
      "paper_scaffold",
      scanPath,
      "--title",
      "Compiled Paperbot tool fixture",
    ],
    cleanPath,
    environment,
  );
  expect(toolDraft.exit_code).toBe(0);
  expect(toolDraft.stdout).toContain("# References");

  const toolValidation = await runProcess(
    [binaryPath, "tools", "paper_validate", fixturePath, "--format", "json"],
    cleanPath,
    environment,
  );
  expect(toolValidation.exit_code).toBe(0);
  expect(JSON.parse(toolValidation.stdout)).toMatchObject({
    schema_version: "1",
    valid: true,
    diagnostics: [],
  });

  const agent = await runProcess(
    [
      binaryPath,
      "agent",
      "run",
      sourcePath,
      "--output",
      join(cleanPath, "agent-run"),
      "--author",
      "Paperbot test",
      "--status",
      "concept",
      "--allow-remote-model",
    ],
    cleanPath,
    environment,
  );
  expect(agent.exit_code).toBe(6);
  expect(agent.stderr).toContain("DEEPSEEK_API_KEY is required");

  const batchInputPath = join(cleanPath, "projects.json");
  await writeFile(batchInputPath, '{"schema_version":"1","projects":[]}\n');
  const batch = await runProcess(
    [
      binaryPath,
      "agent",
      "batch",
      batchInputPath,
      "--output",
      join(cleanPath, "batch-run"),
      "--allow-remote-model",
    ],
    cleanPath,
    environment,
  );
  expect(batch.exit_code).toBe(2);
  expect(batch.stderr).toContain(
    "agent batch manifest projects must not be empty",
  );
}, 15_000);

async function runProcess(
  command: string[],
  cwd: string,
  environment?: Record<string, string | undefined>,
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(command, {
    cwd,
    ...(environment === undefined ? {} : { env: environment }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit_code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exit_code, stdout, stderr };
}
