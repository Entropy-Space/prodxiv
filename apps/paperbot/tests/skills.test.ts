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

  test("lists scopes and components for discovery", async () => {
    const stdout: string[] = [];

    expect(
      await run(["skills"], {
        stdout: (message) => stdout.push(message),
        stderr: () => {},
      }),
    ).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain("project discovery");
    expect(stdout[0]).toContain("paper references");
    expect(stdout[0]).toContain("publication submission");
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
