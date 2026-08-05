import { chmod, lstat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { ExitCode, PaperbotError } from "@prodxiv/paperbot-core";

import { artifactPath, sha256 } from "./artifacts.ts";
import { readArtifact } from "./run-store.ts";
import type {
  AgentSessionRecord,
  ModelSessionSnapshot,
  PiSessionRole,
} from "./types.ts";

const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface CapturedSessionArtifact {
  session_id: string;
  artifact: string;
  artifact_sha256: string;
}

export async function captureSessionArtifact(
  runPath: string,
  role: PiSessionRole,
  snapshot: ModelSessionSnapshot,
): Promise<CapturedSessionArtifact> {
  if (
    typeof snapshot.session_id !== "string" ||
    snapshot.session_id.length === 0
  ) {
    throw invalidSessionRecord(runPath, role);
  }
  const location = resolveSessionLocation(runPath, role, snapshot.session_path);
  await secureSessionLocation(location.directory, location.path, role);
  const serialized = await readArtifact(
    location.path,
    `${role} session`,
    MAX_SESSION_BYTES,
  );
  validatePiSessionJsonLines(serialized, snapshot.session_id, role, runPath);
  return {
    session_id: snapshot.session_id,
    artifact: location.artifact,
    artifact_sha256: sha256(serialized),
  };
}

export async function verifySessionArtifact(
  runPath: string,
  role: PiSessionRole,
  session: AgentSessionRecord,
): Promise<string> {
  if (
    typeof session.artifact !== "string" ||
    session.artifact.length === 0 ||
    typeof session.artifact_sha256 !== "string" ||
    !SHA256_PATTERN.test(session.artifact_sha256)
  ) {
    throw invalidSessionRecord(runPath, role);
  }
  const expectedPrefix = `sessions/${role}/`;
  if (
    !session.artifact.startsWith(expectedPrefix) ||
    !session.artifact.endsWith(".jsonl")
  ) {
    throw invalidSessionRecord(runPath, role);
  }

  const path = artifactPath(runPath, session.artifact);
  const location = resolveSessionLocation(runPath, role, path);
  await secureSessionLocation(location.directory, location.path, role);
  const serialized = await readArtifact(
    location.path,
    `${role} session`,
    MAX_SESSION_BYTES,
  );
  if (sha256(serialized) !== session.artifact_sha256) {
    throw new PaperbotError(
      `agent ${role} session artifact was changed: ${runPath}`,
      ExitCode.io,
    );
  }
  validatePiSessionJsonLines(serialized, session.session_id, role, runPath);
  return location.path;
}

function resolveSessionLocation(
  runPath: string,
  role: PiSessionRole,
  sessionPath: string,
): { artifact: string; directory: string; path: string } {
  if (typeof sessionPath !== "string" || !isAbsolute(sessionPath)) {
    throw invalidSessionRecord(runPath, role);
  }
  const root = resolve(runPath);
  const path = resolve(sessionPath);
  const nativeRelativePath = relative(root, path);
  if (
    nativeRelativePath.length === 0 ||
    nativeRelativePath === ".." ||
    nativeRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(nativeRelativePath)
  ) {
    throw invalidSessionRecord(runPath, role);
  }
  const artifact = nativeRelativePath.split(sep).join("/");
  if (
    !artifact.startsWith(`sessions/${role}/`) ||
    !artifact.endsWith(".jsonl") ||
    dirname(path) !== artifactPath(runPath, `sessions/${role}`)
  ) {
    throw invalidSessionRecord(runPath, role);
  }
  return {
    artifact,
    directory: artifactPath(runPath, `sessions/${role}`),
    path,
  };
}

async function secureSessionLocation(
  directory: string,
  path: string,
  role: PiSessionRole,
): Promise<void> {
  try {
    const [sessionsMetadata, directoryMetadata, fileMetadata] =
      await Promise.all([
        lstat(dirname(directory)),
        lstat(directory),
        lstat(path),
      ]);
    if (
      !sessionsMetadata.isDirectory() ||
      sessionsMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory() ||
      directoryMetadata.isSymbolicLink() ||
      !fileMetadata.isFile() ||
      fileMetadata.isSymbolicLink()
    ) {
      throw new Error("unsafe session location");
    }
    await Promise.all([
      chmod(directory, PRIVATE_DIRECTORY_MODE),
      chmod(path, PRIVATE_FILE_MODE),
    ]);
  } catch {
    throw new PaperbotError(
      `Paperbot could not secure the ${role} Pi session artifact`,
      ExitCode.io,
    );
  }
}

function validatePiSessionJsonLines(
  serialized: string,
  sessionId: string,
  role: PiSessionRole,
  runPath: string,
): void {
  const lines = serialized.endsWith("\n")
    ? serialized.slice(0, -1).split("\n")
    : serialized.split("\n");
  if (lines.length === 0 || lines[0]?.length === 0) {
    throw invalidSessionArtifact(runPath, role);
  }

  let header: Record<string, unknown> | undefined;
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) {
      throw invalidSessionArtifact(runPath, role);
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw invalidSessionArtifact(runPath, role);
    }
    if (!isRecord(value) || typeof value.type !== "string") {
      throw invalidSessionArtifact(runPath, role);
    }
    if (index === 0) {
      header = value;
    } else if (value.type === "session") {
      throw invalidSessionArtifact(runPath, role);
    }
  }

  if (
    header?.type !== "session" ||
    typeof header.version !== "number" ||
    !Number.isInteger(header.version) ||
    header.version < 1 ||
    header.id !== sessionId
  ) {
    throw invalidSessionArtifact(runPath, role);
  }
}

function invalidSessionRecord(
  runPath: string,
  role: PiSessionRole,
): PaperbotError {
  return new PaperbotError(
    `agent ${role} session record is invalid: ${runPath}`,
    ExitCode.io,
  );
}

function invalidSessionArtifact(
  runPath: string,
  role: PiSessionRole,
): PaperbotError {
  return new PaperbotError(
    `agent ${role} session artifact is not valid Pi JSONL: ${runPath}`,
    ExitCode.io,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
