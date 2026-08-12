import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { ExitCode, PaperbotError } from "@prodxiv/paperbot-core";
import { sha256 } from "./artifacts.ts";
import type {
  AgentCheckpointReason,
  AgentCheckpointRecord,
  AgentRunRecord,
} from "./types.ts";

export const CHECKPOINT_MANIFEST_SCHEMA_VERSION = "1";

const MAX_CHECKPOINT_FILE_COUNT = 1_000;
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;
const ZIP_VERSION = 20;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORED_METHOD = 0;

interface CheckpointFile {
  path: string;
  bytes: Uint8Array;
  sha256: string;
  byte_count: number;
}

interface CheckpointManifest {
  schema_version: typeof CHECKPOINT_MANIFEST_SCHEMA_VERSION;
  run_id: string;
  checkpoint_number: number;
  reason: AgentCheckpointReason;
  state: AgentRunRecord["state"];
  created_at: string;
  producer_build_id: string;
  run_record_sha256: string;
  files: Array<{
    path: string;
    sha256: string;
    byte_count: number;
  }>;
}

export async function createRunCheckpoint(
  runPath: string,
  record: AgentRunRecord,
  reason: AgentCheckpointReason,
  createdAt: string,
): Promise<AgentCheckpointRecord> {
  const checkpointNumber = record.checkpoints.length + 1;
  const files = await collectCheckpointFiles(runPath);
  const checkpointBasisSha256 = checkpointBasis(files);
  const runFile = files.find((file) => file.path === "run.json");
  if (runFile === undefined) {
    throw checkpointError("agent checkpoint is missing run.json");
  }
  const manifest: CheckpointManifest = {
    schema_version: CHECKPOINT_MANIFEST_SCHEMA_VERSION,
    run_id: record.run_id,
    checkpoint_number: checkpointNumber,
    reason,
    state: record.state,
    created_at: createdAt,
    producer_build_id: record.producer.build_id,
    run_record_sha256: runFile.sha256,
    files: files.map(({ path, sha256: digest, byte_count }) => ({
      path,
      sha256: digest,
      byte_count,
    })),
  };
  const manifestBytes = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const manifestSha256 = sha256(manifestBytes);
  const archiveBytes = createStoredZip(
    [
      ...files,
      {
        path: "manifest.json",
        bytes: manifestBytes,
        sha256: manifestSha256,
        byte_count: manifestBytes.byteLength,
      },
    ],
    createdAt,
  );
  const archiveSha256 = sha256(archiveBytes);
  const archivePath = await writeCheckpointArchive(
    runPath,
    record,
    checkpointNumber,
    reason,
    archiveBytes,
    archiveSha256,
    createdAt,
  );
  return {
    checkpoint_number: checkpointNumber,
    reason,
    state: record.state,
    created_at: createdAt,
    archive: relative(runPath, archivePath),
    archive_sha256: archiveSha256,
    archive_byte_count: archiveBytes.byteLength,
    manifest_sha256: manifestSha256,
    checkpoint_basis_sha256: checkpointBasisSha256,
  };
}

function checkpointBasis(files: CheckpointFile[]): string {
  return sha256(
    JSON.stringify(
      files.map(({ path, sha256: digest, byte_count }) => ({
        path,
        sha256: digest,
        byte_count,
      })),
    ),
  );
}

async function collectCheckpointFiles(
  runPath: string,
): Promise<CheckpointFile[]> {
  const root = resolve(runPath);
  const files: CheckpointFile[] = [];
  let totalBytes = 0;

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const archivePath = relative(root, path).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) {
        throw checkpointError(
          `agent checkpoint refuses symbolic links: ${archivePath}`,
        );
      }
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) {
        throw checkpointError(
          `agent checkpoint refuses non-file artifacts: ${archivePath}`,
        );
      }
      const bytes = await readFile(path);
      totalBytes += bytes.byteLength;
      if (
        files.length + 1 > MAX_CHECKPOINT_FILE_COUNT ||
        totalBytes > MAX_CHECKPOINT_BYTES
      ) {
        throw checkpointError("agent checkpoint exceeds its bounded size");
      }
      files.push({
        path: archivePath,
        bytes,
        sha256: sha256(bytes),
        byte_count: bytes.byteLength,
      });
    }
  };

  await walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function writeCheckpointArchive(
  runPath: string,
  record: AgentRunRecord,
  checkpointNumber: number,
  reason: AgentCheckpointReason,
  bytes: Uint8Array,
  expectedSha256: string,
  createdAt: string,
): Promise<string> {
  const directory = resolve(dirname(runPath), "checkpoints");
  await secureCheckpointDirectory(directory);
  const date = createdAt.slice(0, 10);
  const runName = safeFilename(basename(runPath));
  const filename =
    record.input.mode === "auto" && reason === "needs_author_review"
      ? `${date}_${runName}_${record.run_id}_final.zip`
      : `${date}_${runName}_${record.run_id}_checkpoint-${checkpointNumber
          .toString()
          .padStart(4, "0")}_${reason}.zip`;
  const target = join(directory, filename);

  try {
    const existing = await readFile(target);
    if (sha256(existing) === expectedSha256) {
      return target;
    }
    throw checkpointError(
      `agent checkpoint archive already exists with different contents: ${target}`,
    );
  } catch (error) {
    if (error instanceof PaperbotError) {
      throw error;
    }
    if (errorCode(error) !== "ENOENT") {
      throw checkpointError(`could not inspect agent checkpoint: ${target}`);
    }
  }

  const temporary = join(
    directory,
    `.${record.run_id}-${crypto.randomUUID()}.paperbot-checkpoint`,
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, target);
    await chmod(target, 0o600);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      const existing = await readFile(target).catch(() => undefined);
      if (existing !== undefined && sha256(existing) === expectedSha256) {
        return target;
      }
    }
    throw checkpointError(`could not write agent checkpoint: ${target}`);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return target;
}

async function secureCheckpointDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("unsafe checkpoint directory");
    }
    await chmod(path, 0o700);
  } catch {
    throw checkpointError(`could not secure checkpoint directory: ${path}`);
  }
}

function createStoredZip(
  files: CheckpointFile[],
  timestamp: string,
): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const { dosDate, dosTime } = zipTimestamp(timestamp);

  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const data = Buffer.from(file.bytes);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    local.writeUInt16LE(ZIP_STORED_METHOD, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(ZIP_VERSION, 6);
    central.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    central.writeUInt16LE(ZIP_STORED_METHOD, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + data.byteLength;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce(
    (total, part) => total + part.byteLength,
    0,
  );
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function zipTimestamp(timestamp: string): { dosDate: number; dosTime: number } {
  const value = new Date(timestamp);
  const year = Math.max(1980, Math.min(2107, value.getUTCFullYear()));
  return {
    dosDate:
      ((year - 1980) << 9) |
      ((value.getUTCMonth() + 1) << 5) |
      value.getUTCDate(),
    dosTime:
      (value.getUTCHours() << 11) |
      (value.getUTCMinutes() << 5) |
      Math.floor(value.getUTCSeconds() / 2),
  };
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = (value >>> 8) ^ CRC32_TABLE[(value ^ byte) & 0xff]!;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function safeFilename(value: string): string {
  const normalized = value.replaceAll(/[^A-Za-z0-9._-]/g, "-");
  return normalized.length === 0 ? "paperbot-run" : normalized.slice(0, 100);
}

function checkpointError(message: string): PaperbotError {
  return new PaperbotError(message, ExitCode.io);
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
