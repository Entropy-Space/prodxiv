import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { parseArguments } from "../src/arguments.ts";
import { run } from "../src/cli.ts";

const fixtureRoot = resolve(import.meta.dir, "fixtures/validation");
const validPaperPath = resolve(fixtureRoot, "valid-paper.md");
const validScanPath = resolve(fixtureRoot, "valid-scan.json");

describe("Paperbot tools interface", () => {
  test("parses direct tool actions and help", () => {
    expect(parseArguments(["tools"])).toEqual({
      command: "tools",
      action: "list",
    });
    expect(parseArguments(["tools", "describe", "paper_validate"])).toEqual({
      command: "tools",
      action: "describe",
      tool_name: "paper_validate",
    });
    expect(
      parseArguments([
        "tools",
        "repo_scan",
        ".",
        "--exclude",
        "docs/**",
        "--format",
        "json",
      ]),
    ).toEqual({
      command: "tools",
      action: "repo_scan",
      repository_path: ".",
      exclusions: ["docs/**"],
      inclusions: [],
      format: "json",
    });
    expect(
      parseArguments([
        "tools",
        "paper_scaffold",
        "scan.json",
        "--title",
        "Fixture",
        "--format=json",
      ]),
    ).toEqual({
      command: "tools",
      action: "paper_scaffold",
      scan_path: "scan.json",
      title: "Fixture",
      format: "json",
    });
    expect(
      parseArguments([
        "tools",
        "paper_validate",
        "paper.md",
        "--profile",
        "publication",
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
    expect(parseArguments(["tools", "--help"])).toEqual({
      command: "tools",
      action: "help",
    });
    expect(() =>
      parseArguments(["tools", "call", "paper_validate", "--input", "-"]),
    ).toThrow("tools requires one of");
    for (const command of ["scan", "draft", "validate"]) {
      expect(() => parseArguments([command])).toThrow(
        `unknown command: ${command}`,
      );
    }
  });

  test("lists only deterministic repository and paper tools", async () => {
    const stdout: string[] = [];

    expect(
      await run(["tools", "list"], {
        stdout: (message) => stdout.push(message),
        stderr: () => {},
      }),
    ).toBe(0);

    const result = JSON.parse(stdout[0] ?? "{}") as {
      schema_version?: string;
      tools?: Array<{
        name?: string;
        invocation?: string;
        human_commands?: string[];
        network_access?: boolean;
      }>;
      excluded_commands?: string[];
    };
    expect(result.schema_version).toBe("1");
    expect(result.tools?.map((tool) => tool.name)).toEqual([
      "repo_scan",
      "paper_scaffold",
      "paper_validate",
    ]);
    expect(result.tools?.find((tool) => tool.name === "repo_scan")).toEqual(
      expect.objectContaining({
        invocation: expect.stringContaining("tools repo_scan"),
        human_commands: ["scan"],
        network_access: false,
      }),
    );
    expect(result.excluded_commands).toEqual(["skills", "auth", "publish"]);
  });

  test("validates a paper with direct CLI arguments", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    expect(
      await run(
        [
          "tools",
          "paper_validate",
          validPaperPath,
          "--profile",
          "draft",
          "--format",
          "json",
        ],
        {
          stdout: (message) => stdout.push(message),
          stderr: (message) => stderr.push(message),
        },
      ),
    ).toBe(0);

    expect(JSON.parse(stdout[0] ?? "{}")).toEqual({
      schema_version: "2",
      valid: true,
      diagnostics: [],
    });
    expect(stderr).toEqual(["paperbot: validation passed with 0 diagnostics"]);
  });

  test("scaffolds a paper and emits Markdown in the tool output", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    expect(
      await run(
        [
          "tools",
          "paper_scaffold",
          validScanPath,
          "--title",
          "Fixture product",
          "--format",
          "json",
        ],
        {
          stdout: (message) => stdout.push(message),
          stderr: (message) => stderr.push(message),
        },
      ),
    ).toBe(0);

    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0] ?? "{}")).toEqual(
      expect.objectContaining({
        schema_version: "2",
        valid: true,
        diagnostics: [],
        markdown: expect.stringContaining("# Summary"),
      }),
    );
  });
});
