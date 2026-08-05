import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PiSessionRole } from "../../src/agent/types.ts";

export async function createFakePiSession(input: {
  role: PiSessionRole;
  run_path: string;
  session_id: string;
  session_path?: string;
}): Promise<string> {
  const sessionDirectory = join(input.run_path, "sessions", input.role);
  const sessionPath =
    input.session_path ?? join(sessionDirectory, `${input.session_id}.jsonl`);
  if (dirname(sessionPath) !== sessionDirectory) {
    throw new Error("fake Pi session path is outside its role directory");
  }

  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  await chmod(sessionDirectory, 0o700);
  try {
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: input.session_id,
        timestamp: new Date().toISOString(),
        cwd: input.run_path,
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
  }
  await chmod(sessionPath, 0o600);
  return sessionPath;
}

export async function appendFakePiTurn(
  sessionPath: string,
  prompt: string,
  response: string | Error,
): Promise<void> {
  const entries = (await readFile(sessionPath, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const lastEntry = entries.at(-1);
  const parentId = lastEntry?.type === "session" ? null : lastEntry?.id;
  await appendFile(
    sessionPath,
    `${JSON.stringify({
      type: "custom",
      id: crypto.randomUUID().slice(0, 8),
      parentId: typeof parentId === "string" ? parentId : null,
      timestamp: new Date().toISOString(),
      customType: "paperbot_test_turn",
      data: {
        prompt,
        response: response instanceof Error ? response.message : response,
        failed: response instanceof Error,
      },
    })}\n`,
  );
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
