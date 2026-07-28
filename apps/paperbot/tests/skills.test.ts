import { describe, expect, test } from "bun:test";

import { parseArguments } from "../src/arguments.ts";
import { run } from "../src/cli.ts";

describe("Paperbot skill catalog", () => {
  test("parses scope, component, and output format", () => {
    expect(
      parseArguments(["skills", "paper", "references", "--format=json"]),
    ).toEqual({
      command: "skills",
      scope: "paper",
      component: "references",
      format: "json",
    });
  });

  test("lists only scope metadata at the first disclosure level", async () => {
    const stdout: string[] = [];

    expect(
      await run(["skills"], {
        stdout: (message) => stdout.push(message),
        stderr: () => {},
      }),
    ).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain("project —");
    expect(stdout[0]).toContain("paper —");
    expect(stdout[0]).toContain("publication —");
    expect(stdout[0]).not.toContain("paper references");
    expect(stdout[0]).not.toContain("# Paperbot paper");
  });

  test("prints a SKILL.md-like scope guide before component details", async () => {
    const stdout: string[] = [];

    expect(
      await run(["skills", "paper"], {
        stdout: (message) => stdout.push(message),
        stderr: () => {},
      }),
    ).toBe(0);
    expect(stdout).toEqual([expect.stringContaining("name: paperbot-paper")]);
    expect(stdout[0]).toContain("# Paperbot paper");
    expect(stdout[0]).toContain("PAPERBOT_CMD skills paper references");
    expect(stdout[0]).not.toContain("the measurement date and environment");
  });

  test("returns only scope metadata in the top-level JSON catalog", async () => {
    const stdout: string[] = [];

    expect(
      await run(["skills", "--format", "json"], {
        stdout: (message) => stdout.push(message),
        stderr: () => {},
      }),
    ).toBe(0);
    expect(JSON.parse(stdout[0] ?? "{}")).toEqual({
      schema_version: "1",
      scopes: [
        {
          scope: "project",
          description: "Understand repository evidence and product intent.",
        },
        {
          scope: "paper",
          description: "Author evidence-backed product paper content.",
        },
        {
          scope: "publication",
          description: "Prepare and explicitly submit an immutable version.",
        },
      ],
    });
  });

  test("prints focused Markdown guidance", async () => {
    const stdout: string[] = [];

    expect(
      await run(["skills", "paper", "benchmarks"], {
        stdout: (message) => stdout.push(message),
        stderr: () => {},
      }),
    ).toBe(0);
    expect(stdout).toEqual([expect.stringContaining("# Paper benchmarks")]);
    expect(stdout[0]).toContain("omit the Benchmarks");
    expect(stdout[0]).not.toContain("# Paper figures");
  });

  test("returns a versioned JSON component", async () => {
    const stdout: string[] = [];

    expect(
      await run(["skills", "paper", "references", "--format", "json"], {
        stdout: (message) => stdout.push(message),
        stderr: () => {},
      }),
    ).toBe(0);
    expect(JSON.parse(stdout[0] ?? "{}")).toEqual(
      expect.objectContaining({
        schema_version: "1",
        scope: "paper",
        component: "references",
        instructions: expect.stringContaining("# Paper references"),
      }),
    );
  });

  test("returns versioned scope guidance without expanding components", async () => {
    const stdout: string[] = [];

    expect(
      await run(["skills", "project", "--format", "json"], {
        stdout: (message) => stdout.push(message),
        stderr: () => {},
      }),
    ).toBe(0);
    const result = JSON.parse(stdout[0] ?? "{}") as {
      schema_version?: string;
      scope?: string;
      instructions?: string;
      components?: Array<{ component?: string }>;
    };
    expect(result).toEqual(
      expect.objectContaining({
        schema_version: "1",
        scope: "project",
        instructions: expect.stringContaining("name: paperbot-project"),
      }),
    );
    expect(result.components?.map(({ component }) => component)).toEqual([
      "discovery",
      "architecture",
      "intent",
    ]);
    expect(result.instructions).not.toContain("# Project discovery");
  });

  test("reports valid choices for an unknown component", async () => {
    const stderr: string[] = [];

    expect(
      await run(["skills", "paper", "unknown"], {
        stdout: () => {},
        stderr: (message) => stderr.push(message),
      }),
    ).toBe(2);
    expect(stderr).toEqual([
      "paperbot: unknown paper skill component: unknown; expected one of: structure, references, benchmarks, figures",
    ]);
  });
});
