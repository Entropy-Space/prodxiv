import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
  PiAgentRuntime,
  PiAuthoringRuntime,
} from "../src/agent/pi.ts";

let temporaryPath = "";

afterEach(async () => {
  if (temporaryPath.length > 0) {
    await rm(temporaryPath, { recursive: true, force: true });
  }
});

test("creates a persistent Pi session with no tools or discovered resources", async () => {
  temporaryPath = await mkdtemp(join(tmpdir(), "paperbot-pi-"));
  const sessionDirectory = join(temporaryPath, "sessions", "test");
  const session = await createIsolatedPiSession({
    api_key: "test-deepseek-key",
    model: "deepseek-v4-flash",
    run_path: temporaryPath,
    session_directory: sessionDirectory,
  });

  try {
    expect(session.sessionManager.isPersisted()).toBe(true);
    expect(session.sessionFile.startsWith(sessionDirectory)).toBe(true);
    const [header] = (await readFile(session.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(header).toMatchObject({
      type: "session",
      id: session.sessionId,
      cwd: temporaryPath,
    });
    expect((await stat(session.sessionFile)).mode & 0o777).toBe(0o600);
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
    session_directory: join(temporaryPath, "sessions", "router"),
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

test("allocates private persistent paths for each bounded workflow role", async () => {
  temporaryPath = await mkdtemp(join(tmpdir(), "paperbot-pi-"));
  const runtime = new PiAuthoringRuntime({ api_key: "test-deepseek-key" });
  const trendRuntime = new PiAgentRuntime({
    api_key: "test-deepseek-key",
    system_prompt: "Select from the supplied trend snapshot only.",
  });

  const evidence = await runtime.startSession({
    role: "evidence",
    run_path: temporaryPath,
  });
  const author = await runtime.startSession({
    role: "author",
    run_path: temporaryPath,
  });
  const trend = await trendRuntime.startSession({
    role: "trend_selection",
    run_path: temporaryPath,
  });
  try {
    expect(
      evidence
        .snapshot()
        .session_path.startsWith(join(temporaryPath, "sessions", "evidence")),
    ).toBe(true);
    expect(
      author
        .snapshot()
        .session_path.startsWith(join(temporaryPath, "sessions", "author")),
    ).toBe(true);
    expect(
      trend
        .snapshot()
        .session_path.startsWith(
          join(temporaryPath, "sessions", "trend_selection"),
        ),
    ).toBe(true);
    expect(
      (await stat(join(temporaryPath, "sessions", "evidence"))).mode & 0o777,
    ).toBe(0o700);
    expect(
      (await stat(join(temporaryPath, "sessions", "author"))).mode & 0o777,
    ).toBe(0o700);
    expect(
      (await stat(join(temporaryPath, "sessions", "trend_selection"))).mode &
        0o777,
    ).toBe(0o700);
    expect((await stat(evidence.snapshot().session_path)).mode & 0o777).toBe(
      0o600,
    );
    expect((await stat(author.snapshot().session_path)).mode & 0o777).toBe(
      0o600,
    );
    expect((await stat(trend.snapshot().session_path)).mode & 0o777).toBe(
      0o600,
    );
  } finally {
    await evidence.dispose();
    await author.dispose();
    await trend.dispose();
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
    runtime.startSession({ role: "author", run_path: "/not-used" }),
  ).rejects.toEqual(
    expect.objectContaining({
      exit_code: 6,
      message:
        "DEEPSEEK_API_KEY is required when PAPERBOT_MODEL_BASE_URL is not configured",
    } satisfies Partial<PaperbotError>),
  );
});
