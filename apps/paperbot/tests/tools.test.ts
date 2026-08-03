import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseArguments } from "../src/arguments.ts";
import { run } from "../src/cli.ts";

const validPaperPath = resolve(
  import.meta.dir,
  "fixtures/validation/valid-paper.md",
);

describe("Paperbot tools interface", () => {
  test("parses list, describe, call, and help actions", () => {
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
      parseArguments(["tools", "call", "paper_validate", "--input", "-"]),
    ).toEqual({
      command: "tools",
      action: "call",
      tool_name: "paper_validate",
      input_path: "-",
    });
    expect(parseArguments(["tools", "--help"])).toEqual({
      command: "tools",
      action: "help",
    });
  });

  test("lists deterministic tools and keeps publication outside the catalog", async () => {
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
        human_commands?: string[];
        network_access?: boolean;
      }>;
      excluded_commands?: string[];
    };
    expect(result.schema_version).toBe("1");
    expect(result.tools?.map((tool) => tool.name)).toEqual([
      "repository_scan",
      "paper_scaffold",
      "paper_validate",
      "skill_catalog",
      "skill_read",
      "prompt_catalog",
    ]);
    expect(
      result.tools?.find((tool) => tool.name === "paper_validate"),
    ).toEqual(
      expect.objectContaining({
        human_commands: ["validate"],
        network_access: false,
      }),
    );
    expect(result.excluded_commands).toEqual(["auth", "publish"]);
  });

  test("calls a validation tool with a versioned JSON request", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "paperbot-tools-"));
    try {
      const requestPath = join(workspacePath, "request.json");
      await writeFile(
        requestPath,
        `${JSON.stringify(
          {
            schema_version: "1",
            arguments: {
              input_path: validPaperPath,
              profile: "draft",
            },
          },
          null,
          2,
        )}\n`,
      );
      const stdout: string[] = [];
      const stderr: string[] = [];

      expect(
        await run(["tools", "call", "paper_validate", "--input", requestPath], {
          stdout: (message) => stdout.push(message),
          stderr: (message) => stderr.push(message),
        }),
      ).toBe(0);

      expect(JSON.parse(stdout[0] ?? "{}")).toEqual(
        expect.objectContaining({
          schema_version: "1",
          tool_name: "paper_validate",
          ok: true,
          result: expect.objectContaining({
            profile: "draft",
            report: expect.objectContaining({ valid: true }),
          }),
        }),
      );
      expect(stderr).toEqual([]);
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  test("returns structured failures for invalid tool input", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    expect(
      await run(["tools", "call", "skill_catalog", "--input", "-"], {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        read_stdin: async () =>
          JSON.stringify({
            schema_version: "1",
            arguments: { unexpected: true },
          }),
      }),
    ).toBe(2);

    expect(JSON.parse(stdout[0] ?? "{}")).toEqual({
      schema_version: "1",
      tool_name: "skill_catalog",
      ok: false,
      error: {
        message: "skill_catalog does not accept argument: unexpected",
        exit_code: 2,
      },
    });
    expect(stderr).toEqual([
      "paperbot: skill_catalog does not accept argument: unexpected",
    ]);
  });

  test("reads skill guidance through the same JSON tool contract", async () => {
    const stdout: string[] = [];

    expect(
      await run(["tools", "call", "skill_read", "--input", "-"], {
        stdout: (message) => stdout.push(message),
        stderr: () => {},
        read_stdin: async () =>
          JSON.stringify({
            schema_version: "1",
            arguments: { scope: "paper", component: "references" },
          }),
      }),
    ).toBe(0);

    expect(JSON.parse(stdout[0] ?? "{}")).toEqual(
      expect.objectContaining({
        tool_name: "skill_read",
        ok: true,
        result: expect.objectContaining({
          scope: "paper",
          component: "references",
          instructions: expect.stringContaining("# Paper references"),
        }),
      }),
    );
  });
});
