import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PaperbotError } from "../src/errors.ts";
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

test("does not create a session or expose a missing DeepSeek key", async () => {
  const runtime = new PiAuthoringRuntime({ api_key: "" });

  await expect(
    runtime.complete({ prompt: "draft", run_path: "/not-used" }),
  ).rejects.toEqual(
    expect.objectContaining({
      exit_code: 6,
      message: "DEEPSEEK_API_KEY is required for the Pi agent runtime",
    } satisfies Partial<PaperbotError>),
  );
});
