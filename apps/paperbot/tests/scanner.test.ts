import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseArguments } from "../src/arguments.ts";
import { run } from "../src/cli.ts";
import { scanRepository } from "../src/scanner.ts";

const fixturePath = resolve(import.meta.dir, "fixtures/repository");
let repositoryPath = "";

beforeEach(async () => {
  repositoryPath = await mkdtemp(join(tmpdir(), "paperbot-scan-"));
  await cp(fixturePath, repositoryPath, { recursive: true });
  await mkdir(join(repositoryPath, "dist"), { recursive: true });
  await mkdir(join(repositoryPath, "node_modules", "example"), {
    recursive: true,
  });
  await writeFile(
    join(repositoryPath, ".env"),
    "API_TOKEN=must-not-be-indexed\n",
  );
  await writeFile(
    join(repositoryPath, "secret.pem"),
    "-----BEGIN PRIVATE KEY-----\nmust-not-be-indexed\n-----END PRIVATE KEY-----\n",
  );
  await writeFile(
    join(repositoryPath, "CREDENTIALS.JSON"),
    '{"token":"must-not-be-indexed"}\n',
  );
  await writeFile(
    join(repositoryPath, "dist", "bundle.ts"),
    "export const bundled = true;\n",
  );
  await writeFile(
    join(repositoryPath, "node_modules", "example", "index.ts"),
    "export const vendored = true;\n",
  );
  await writeFile(join(repositoryPath, "binary.ts"), Buffer.from([0, 1, 2, 3]));
  await writeFile(
    join(repositoryPath, "oversized.ts"),
    Buffer.alloc(1024 * 1024 + 1, "a"),
  );
  await mkdir(join(repositoryPath, "ignored"));
  await writeFile(
    join(repositoryPath, "ignored", "ignored.ts"),
    "export const ignored = true;\n",
  );
  await writeFile(join(repositoryPath, "image.png"), "not source evidence\n");
  await symlink("src/index.ts", join(repositoryPath, "linked.ts"));

  await git(["init", "-q"]);
  await git(["config", "user.email", "paperbot@example.test"]);
  await git(["config", "user.name", "Paperbot Fixture"]);
  await git([
    "remote",
    "add",
    "origin",
    "https://token:must-not-leak@github.com/example/product.git",
  ]);
  await git(["add", "-A"]);
  await git([
    "add",
    "-f",
    ".env",
    "CREDENTIALS.JSON",
    "secret.pem",
    "dist/bundle.ts",
    "node_modules/example/index.ts",
  ]);
  await git(["commit", "-q", "-m", "fixture"]);
});

afterEach(async () => {
  await rm(repositoryPath, { recursive: true, force: true });
});

describe("scanRepository", () => {
  test("indexes supported evidence deterministically and excludes unsafe files", async () => {
    const first = await scanRepository(repositoryPath, {
      exclusions: ["docs/private.md"],
    });
    const second = await scanRepository(repositoryPath, {
      exclusions: ["docs/private.md"],
    });

    expect(first.bundle).toEqual(second.bundle);
    expect(first.bundle.schema_version).toBe("1");
    expect(first.bundle.repository.is_dirty).toBe(false);
    expect(first.bundle.repository.source_url).toBe(
      "https://github.com/example/product",
    );
    expect(first.bundle.claims).toEqual([]);

    const paths = first.bundle.sources.map((source) => source.path);
    expect(paths).toEqual([
      ".gitignore",
      "README.md",
      "benches/latency.ts",
      "config/app.toml",
      "package.json",
      "src/index.ts",
      "src/secret-scanner.ts",
      "tests/index.test.ts",
    ]);
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain("CREDENTIALS.JSON");
    expect(paths).not.toContain("secret.pem");
    expect(paths).not.toContain("dist/bundle.ts");
    expect(paths).not.toContain("node_modules/example/index.ts");
    expect(paths).not.toContain("src/client.generated.ts");
    expect(paths).not.toContain("linked.ts");
    expect(first.skipped_file_counts.binary).toBe(1);
    expect(first.skipped_file_counts.generated).toBe(1);
    expect(first.skipped_file_counts.oversized).toBe(1);
    expect(first.skipped_file_counts.symlink).toBe(1);

    expect(sourceType(first, "README.md")).toBe("documentation");
    expect(sourceType(first, "benches/latency.ts")).toBe("benchmark");
    expect(sourceType(first, "config/app.toml")).toBe("configuration");
    expect(sourceType(first, "package.json")).toBe("manifest");
    expect(sourceType(first, "src/index.ts")).toBe("source_code");
    expect(sourceType(first, "tests/index.test.ts")).toBe("test");
  });

  test("includes non-ignored untracked files and marks the snapshot dirty", async () => {
    await writeFile(
      join(repositoryPath, "src/untracked.ts"),
      "export const untracked = true;\n",
    );

    const result = await scanRepository(repositoryPath);

    expect(result.bundle.repository.is_dirty).toBe(true);
    expect(
      result.bundle.sources.some(
        (source) => source.path === "src/untracked.ts",
      ),
    ).toBe(true);
    expect(
      result.bundle.sources.some(
        (source) => source.path === "ignored/ignored.ts",
      ),
    ).toBe(false);
  });

  test("limits a nested scan to the requested directory", async () => {
    await writeFile(
      join(repositoryPath, "README.md"),
      "# Changed outside the requested scope\n",
    );

    const cleanScope = await scanRepository(join(repositoryPath, "src"));

    expect(cleanScope.repository_path).toBe(
      await realpath(join(repositoryPath, "src")),
    );
    expect(cleanScope.bundle.repository.is_dirty).toBe(false);
    expect(cleanScope.bundle.sources.map((source) => source.path)).toEqual([
      "src/index.ts",
      "src/secret-scanner.ts",
    ]);

    await writeFile(
      join(repositoryPath, "src", "index.ts"),
      "export const changedInsideScope = true;\n",
    );

    const dirtyScope = await scanRepository(join(repositoryPath, "src"));

    expect(dirtyScope.bundle.repository.is_dirty).toBe(true);
  });
});

describe("CLI", () => {
  test("parses repeatable exclusions and JSON output", () => {
    expect(
      parseArguments([
        "scan",
        "./repo",
        "--format=json",
        "--exclude",
        "private/**",
        "--exclude=tmp/**",
        "--include",
        ".env.example",
      ]),
    ).toEqual({
      command: "scan",
      repository_path: "./repo",
      format: "json",
      exclusions: ["private/**", "tmp/**"],
      inclusions: [".env.example"],
    });
  });

  test("allows a tracked environment template to be explicitly included", async () => {
    const result = await scanRepository(repositoryPath, {
      inclusions: [".env"],
    });

    expect(result.bundle.sources.some((source) => source.path === ".env")).toBe(
      true,
    );
    expect(sourceType(result, ".env")).toBe("configuration");

    const explicitlyExcluded = await scanRepository(repositoryPath, {
      inclusions: [".env"],
      exclusions: [".env"],
    });
    expect(
      explicitlyExcluded.bundle.sources.some(
        (source) => source.path === ".env",
      ),
    ).toBe(false);
  });

  test("writes only the evidence bundle to stdout in JSON mode", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await run(["scan", repositoryPath, "--format", "json"], {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    });

    expect(exitCode).toBe(0);
    expect(stdout).toHaveLength(1);
    const bundle = JSON.parse(stdout[0] ?? "{}") as {
      schema_version?: string;
      sources?: Array<{ path: string }>;
    };
    expect(bundle.schema_version).toBe("1");
    expect(bundle.sources?.some((source) => source.path === ".env")).toBe(
      false,
    );
    expect(stderr).toEqual([expect.stringContaining("paperbot: scanned")]);
  });

  test("returns a stable usage exit code for invalid options", async () => {
    const stderr: string[] = [];
    const exitCode = await run(["scan", "--format", "yaml"], {
      stdout: () => {},
      stderr: (message) => stderr.push(message),
    });

    expect(exitCode).toBe(2);
    expect(stderr).toEqual(["paperbot: unsupported output format: yaml"]);
  });

  test("returns a stable repository exit code for an unreadable path", async () => {
    const stderr: string[] = [];
    const exitCode = await run(["scan", join(repositoryPath, "missing")], {
      stdout: () => {},
      stderr: (message) => stderr.push(message),
    });

    expect(exitCode).toBe(3);
    expect(stderr).toEqual([
      expect.stringContaining("repository path is not a readable directory"),
    ]);
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

function sourceType(
  result: Awaited<ReturnType<typeof scanRepository>>,
  path: string,
): string | undefined {
  return result.bundle.sources.find((source) => source.path === path)
    ?.source_type;
}
