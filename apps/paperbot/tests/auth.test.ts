import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  initializeAuth,
  removeAuth,
  resolveAuth,
  saveAuth,
} from "../src/auth.ts";
import { parseArguments } from "../src/arguments.ts";
import { ExitCode, PaperbotError } from "../src/errors.ts";

const token = "paperbot_test_token_with_32_characters";
let workspacePath = "";
let authPath = "";

beforeEach(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), "paperbot-auth-"));
  authPath = join(workspacePath, ".tokn", "prodxiv", "auth.toml");
});

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true });
});

describe("Paperbot authentication", () => {
  test("uses bare auth and auth init to bootstrap credentials", () => {
    expect(parseArguments(["auth"])).toEqual({
      command: "auth",
      action: "init",
    });
    expect(parseArguments(["auth", "init"])).toEqual({
      command: "auth",
      action: "init",
    });
  });

  test("stores and resolves a protected TOML credential", async () => {
    await saveAuth("https://api.prodxiv.example/", token, authPath);

    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    expect(
      (await stat(join(workspacePath, ".tokn", "prodxiv"))).mode & 0o777,
    ).toBe(0o700);
    expect(await readFile(authPath, "utf8")).toBe(
      [
        "# Paperbot publishing credentials.",
        "# This file contains a secret. Keep its permissions set to 0600.",
        "version = 1",
        "",
        "# Base URL of the prodxiv publishing API.",
        'api_url = "https://api.prodxiv.example"',
        "",
        "# Bearer token used only for explicit publication requests.",
        `token = "${token}"`,
        "",
      ].join("\n"),
    );
    expect(
      await resolveAuth({
        auth_path: authPath,
        env: {},
      }),
    ).toEqual({
      version: 1,
      api_url: "https://api.prodxiv.example",
      token,
      source: "file",
    });
  });

  test("creates a commented template without overwriting it", async () => {
    expect(await initializeAuth(authPath)).toBe(true);

    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    const template = await readFile(authPath, "utf8");
    expect(template).toContain("# Paperbot publishing credentials.");
    expect(template).toContain(
      '# api_url = "https://your-prodxiv-api.example"',
    );
    expect(template).toContain(
      '# token = "replace-with-your-publishing-token"',
    );

    expect(await initializeAuth(authPath)).toBe(false);
    expect(await readFile(authPath, "utf8")).toBe(template);
    await expect(
      resolveAuth({ auth_path: authPath, env: {} }),
    ).rejects.toMatchObject({
      exit_code: ExitCode.auth,
      message: expect.stringContaining("authentication template is incomplete"),
    });
    expect(await readFile(authPath, "utf8")).toBe(template);
  });

  test("does not create credentials while resolving missing auth", async () => {
    await expect(
      resolveAuth({ auth_path: authPath, env: {} }),
    ).rejects.toMatchObject({
      exit_code: ExitCode.auth,
      message: expect.stringContaining("authentication is not configured"),
    });
    expect(Bun.file(authPath).size).toBe(0);
    expect(await Bun.file(authPath).exists()).toBe(false);
  });

  test("refuses to read a credential visible to other users", async () => {
    await saveAuth("https://api.prodxiv.example", token, authPath);
    await chmod(authPath, 0o644);

    expect(
      resolveAuth({
        auth_path: authPath,
        env: {},
      }),
    ).rejects.toMatchObject({
      exit_code: ExitCode.auth,
    } satisfies Partial<PaperbotError>);
  });

  test("supports environment-only credentials and idempotent removal", async () => {
    expect(
      await resolveAuth({
        auth_path: authPath,
        env: {
          PRODXIV_API_URL: "https://api.prodxiv.example",
          PRODXIV_PUBLISH_TOKEN: token,
        },
      }),
    ).toMatchObject({
      api_url: "https://api.prodxiv.example",
      token,
      source: "environment",
    });

    expect(await removeAuth(authPath)).toBe(false);
    await saveAuth("https://api.prodxiv.example", token, authPath);
    expect(await removeAuth(authPath)).toBe(true);
    expect(await removeAuth(authPath)).toBe(false);
  });
});
