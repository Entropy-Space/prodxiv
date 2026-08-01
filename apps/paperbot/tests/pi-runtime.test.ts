import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PaperbotError } from "@prodxiv/paperbot-core";
import {
  normalizeLoopbackBaseUrl,
  redactModelSecrets,
  resolvePiConnection,
} from "../src/agent/model-config.ts";
import {
  createIsolatedPiSession,
  PiAuthoringRuntime,
} from "../src/agent/pi.ts";

let temporaryPath = "";

afterEach(async () => {
  if (temporaryPath.length > 0) {
    await rm(temporaryPath, { recursive: true, force: true });
  }
});

test("creates an in-memory Pi session with no tools or discovered resources", async () => {
  temporaryPath = await mkdtemp(join(tmpdir(), "paperbot-pi-"));
  const session = await createIsolatedPiSession({
    api_key: "test-deepseek-key",
    model: "deepseek-v4-flash",
    run_path: temporaryPath,
  });

  try {
    expect(session.getActiveToolNames()).toEqual([]);
    expect(session.resourceLoader.getExtensions().extensions).toEqual([]);
    expect(session.resourceLoader.getSkills().skills).toEqual([]);
    expect(session.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
  } finally {
    session.dispose();
  }
});

test("uses a loopback model router without reading Pi user configuration", async () => {
  temporaryPath = await mkdtemp(join(tmpdir(), "paperbot-pi-"));
  const session = await createIsolatedPiSession({
    api_key: "paperbot-local-router",
    base_url: "http://localhost:4141/v1/",
    model: "deepseek-v4-flash",
    run_path: temporaryPath,
  });

  try {
    expect(session.model).toMatchObject({
      provider: "deepseek",
      id: "deepseek-v4-flash",
      baseUrl: "http://localhost:4141/v1",
    });
    expect(session.getActiveToolNames()).toEqual([]);
  } finally {
    session.dispose();
  }
});

test("allows a keyless loopback router but rejects unsafe model endpoints", () => {
  expect(
    resolvePiConnection({ base_url: "http://127.0.0.1:4141/v1" }, {}),
  ).toEqual({
    api_key: "paperbot-local-router",
    base_url: "http://127.0.0.1:4141/v1",
  });
  expect(
    resolvePiConnection(
      { base_url: "http://localhost:4141/v1" },
      { PAPERBOT_MODEL_API_KEY: "router-secret" },
    ),
  ).toEqual({
    api_key: "router-secret",
    base_url: "http://localhost:4141/v1",
  });

  for (const endpoint of [
    "https://model.example.test/v1",
    "http://localhost:4141/v1?token=secret",
    "http://token@localhost:4141/v1",
  ]) {
    expect(() => normalizeLoopbackBaseUrl(endpoint)).toThrow(PaperbotError);
  }
});

test("redacts direct and router credentials from persisted diagnostics", () => {
  expect(
    redactModelSecrets(
      "deepseek-secret router-secret tokn-secret explicit-secret",
      ["explicit-secret"],
      {
        DEEPSEEK_API_KEY: "deepseek-secret",
        PAPERBOT_MODEL_API_KEY: "router-secret",
        TOKN_API_KEY: "tokn-secret",
      },
    ),
  ).toBe("[redacted] [redacted] [redacted] [redacted]");
});

test("does not create a session or expose a missing DeepSeek key", async () => {
  const runtime = new PiAuthoringRuntime({ api_key: "" });

  await expect(
    runtime.complete({ prompt: "draft", run_path: "/not-used" }),
  ).rejects.toEqual(
    expect.objectContaining({
      exit_code: 6,
      message:
        "DEEPSEEK_API_KEY is required when PAPERBOT_MODEL_BASE_URL is not configured",
    } satisfies Partial<PaperbotError>),
  );
});
