import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ExitCode, PaperbotError } from "../errors.ts";
import { inspectGitRepository } from "../git.ts";
import { type ScanFileType, validateScanManifest } from "../scan-manifest.ts";
import { scanRepository } from "../scanner.ts";
import {
  artifactPath,
  ensureRunDirectory,
  sha256,
  writeJsonArtifact,
  writeTextArtifact,
} from "./artifacts.ts";
import type { AgentSource, AgentSourceFile } from "./types.ts";
import type { GitHubSourceResult } from "./github-source.ts";
import { normalizeAnonymousHttpUrl } from "./input.ts";

const MAX_AGENT_FILE_BYTES = 48 * 1024;
const MAX_AGENT_TOTAL_BYTES = 384 * 1024;
const MAX_AGENT_SOURCE_FILES = 30;
const MAX_SOURCE_ARTIFACT_BYTES = 256 * 1024;
const MAX_SCAN_ARTIFACT_BYTES = 8 * 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

const FILE_TYPE_LIMITS: Readonly<Record<ScanFileType, number>> = {
  documentation: 6,
  manifest: 6,
  configuration: 4,
  source_code: 10,
  test: 3,
  benchmark: 1,
};

const NON_OVERRIDABLE_SENSITIVE_PATHS = [
  /(^|\/)\.env(?:\.|rc$|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)credentials?(?:\.|\/|$)/i,
  /(^|\/)secrets?(?:\.|\/|$)/i,
  /(^|\/)(?:id_rsa|id_ecdsa|id_ed25519|id_dsa)/i,
  /\.(?:pem|key|p12|pfx)$/i,
];
const SECRET_MARKERS = [
  "-----begin private key-----",
  "-----begin rsa private key-----",
  "-----begin ec private key-----",
  "-----begin openssh private key-----",
];

export async function acquireLocalSource(
  repositoryPath: string,
): Promise<AgentSource> {
  const [scan, repository] = await Promise.all([
    scanRepository(repositoryPath),
    inspectGitRepository(repositoryPath),
  ]);
  const selected = await selectLocalFiles(
    repository.root_path,
    scan.manifest.files,
  );
  if (selected.length === 0) {
    throw new PaperbotError(
      "agent source contains no safely bounded files to send to a remote model",
      ExitCode.scan,
    );
  }
  return {
    kind: "local",
    local_path: repository.root_path,
    resolved_revision: scan.manifest.repository.revision,
    is_dirty: scan.manifest.repository.is_dirty,
    retrieved_at: new Date().toISOString(),
    ...(scan.manifest.repository.source_url === undefined
      ? {}
      : { canonical_url: scan.manifest.repository.source_url }),
    files: selected,
    scan_manifest: scan.manifest,
  };
}

export function sourceFromGitHubResult(
  result: GitHubSourceResult,
): AgentSource {
  const files = result.files
    .filter((file) => !isSensitivePath(file.path))
    .filter((file) => !includesSensitiveMarker(file.content))
    .map((file) => ({
      ...file,
      source_id: `repository:${file.path}`,
    }));
  if (files.length === 0) {
    throw new PaperbotError(
      "public GitHub source contains no safely bounded files to send to a remote model",
      ExitCode.scan,
    );
  }
  return {
    kind: "github",
    canonical_url: result.canonical_url,
    ...(result.requested_ref === undefined
      ? {}
      : { requested_ref: result.requested_ref }),
    resolved_revision: result.resolved_revision,
    is_dirty: false,
    retrieved_at: result.retrieved_at,
    ...(result.homepage_url === undefined
      ? {}
      : { homepage_url: result.homepage_url }),
    files,
    scan_manifest: {
      schema_version: "1",
      repository: {
        source_url: result.canonical_url,
        revision: result.resolved_revision,
        is_dirty: false,
      },
      files: files.map(({ path, file_type }) => ({ path, file_type })),
    },
  };
}

export async function writeSourceArtifacts(
  runPath: string,
  source: AgentSource,
): Promise<{ source_path: string; scan_path: string }> {
  for (const file of source.files) {
    await writeTextArtifact(runPath, `source/${file.path}`, file.content);
  }
  const sourcePath = await writeJsonArtifact(runPath, "source.json", {
    schema_version: "1",
    kind: source.kind,
    ...(source.canonical_url === undefined
      ? {}
      : { canonical_url: source.canonical_url }),
    ...(source.local_path === undefined
      ? {}
      : { local_path: source.local_path }),
    ...(source.requested_ref === undefined
      ? {}
      : { requested_ref: source.requested_ref }),
    resolved_revision: source.resolved_revision,
    is_dirty: source.is_dirty,
    retrieved_at: source.retrieved_at,
    ...(source.homepage_url === undefined
      ? {}
      : { homepage_url: source.homepage_url }),
    files: source.files.map((file) => ({
      path: file.path,
      file_type: file.file_type,
      content_sha256: file.content_sha256,
      byte_count: file.byte_count,
      source_id: file.source_id,
    })),
  });
  const scanPath = await writeJsonArtifact(
    runPath,
    "scan.json",
    source.scan_manifest,
  );
  return { source_path: sourcePath, scan_path: scanPath };
}

export async function readSourceArtifact(
  runPath: string,
): Promise<AgentSource> {
  const securedRunPath = await ensureRunDirectory(runPath);
  const sourcePath = artifactPath(securedRunPath, "source.json");
  const scanPath = artifactPath(securedRunPath, "scan.json");
  let rawSource: unknown;
  let rawScan: unknown;
  try {
    rawSource = JSON.parse(
      await readStoredArtifactText(
        sourcePath,
        "agent source artifact",
        MAX_SOURCE_ARTIFACT_BYTES,
      ),
    ) as unknown;
    rawScan = JSON.parse(
      await readStoredArtifactText(
        scanPath,
        "agent scan artifact",
        MAX_SCAN_ARTIFACT_BYTES,
      ),
    ) as unknown;
  } catch {
    throw new PaperbotError(
      `could not read agent source artifacts: ${runPath}`,
      ExitCode.io,
    );
  }
  if (!isRecord(rawSource) || !isRecord(rawScan)) {
    throw new PaperbotError(
      `agent source artifacts are invalid: ${runPath}`,
      ExitCode.io,
    );
  }
  const kind = rawSource.kind;
  const revision = rawSource.resolved_revision;
  const retrievedAt = rawSource.retrieved_at;
  const dirty = rawSource.is_dirty;
  if (
    rawSource.schema_version !== "1" ||
    (kind !== "github" && kind !== "local") ||
    typeof revision !== "string" ||
    typeof retrievedAt !== "string" ||
    typeof dirty !== "boolean" ||
    (rawSource.canonical_url !== undefined &&
      typeof rawSource.canonical_url !== "string") ||
    (rawSource.local_path !== undefined &&
      typeof rawSource.local_path !== "string") ||
    (rawSource.requested_ref !== undefined &&
      typeof rawSource.requested_ref !== "string") ||
    (rawSource.homepage_url !== undefined &&
      typeof rawSource.homepage_url !== "string") ||
    !Array.isArray(rawSource.files) ||
    rawSource.files.length === 0 ||
    rawSource.files.length > MAX_AGENT_SOURCE_FILES
  ) {
    throw new PaperbotError(
      `agent source artifact has an unsupported shape: ${runPath}`,
      ExitCode.io,
    );
  }
  await assertRealDirectory(artifactPath(securedRunPath, "source"));
  const files = await Promise.all(
    rawSource.files.map((entry, index) =>
      readStoredSourceFile(securedRunPath, entry, index),
    ),
  );
  const scanValidation = validateScanManifest(rawScan);
  if (scanValidation.manifest === undefined) {
    throw new PaperbotError(
      `agent scan artifact has an unsupported shape: ${runPath}`,
      ExitCode.io,
    );
  }
  const source: AgentSource = {
    kind,
    ...(typeof rawSource.canonical_url === "string"
      ? {
          canonical_url: readStoredUrl(
            rawSource.canonical_url,
            "canonical_url",
            securedRunPath,
          ),
        }
      : {}),
    ...(typeof rawSource.local_path === "string"
      ? { local_path: rawSource.local_path }
      : {}),
    ...(typeof rawSource.requested_ref === "string"
      ? { requested_ref: rawSource.requested_ref }
      : {}),
    resolved_revision: readStoredRevision(revision, securedRunPath),
    is_dirty: dirty,
    retrieved_at: readStoredTimestamp(retrievedAt, securedRunPath),
    ...(typeof rawSource.homepage_url === "string"
      ? {
          homepage_url: readStoredUrl(
            rawSource.homepage_url,
            "homepage_url",
            securedRunPath,
          ),
        }
      : {}),
    files,
    scan_manifest: scanValidation.manifest,
  };
  validateRestoredSource(source, securedRunPath);
  return source;
}

async function selectLocalFiles(
  repositoryRoot: string,
  candidates: Array<{ path: string; file_type: ScanFileType }>,
): Promise<AgentSourceFile[]> {
  const byType = new Map<ScanFileType, number>();
  const selected: AgentSourceFile[] = [];
  let totalBytes = 0;

  for (const candidate of prioritizeCandidates(candidates)) {
    if (isSensitivePath(candidate.path)) {
      continue;
    }
    if (
      (byType.get(candidate.file_type) ?? 0) >=
      FILE_TYPE_LIMITS[candidate.file_type]
    ) {
      continue;
    }
    const filePath = resolve(repositoryRoot, candidate.path);
    if (!filePath.startsWith(`${repositoryRoot}/`)) {
      continue;
    }
    let metadata;
    try {
      metadata = await lstat(filePath);
    } catch {
      continue;
    }
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_AGENT_FILE_BYTES ||
      totalBytes + metadata.size > MAX_AGENT_TOTAL_BYTES
    ) {
      continue;
    }
    let content: Buffer;
    try {
      content = await readFile(filePath);
    } catch {
      continue;
    }
    if (content.includes(0)) {
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      continue;
    }
    if (includesSensitiveMarker(text)) {
      continue;
    }
    selected.push({
      path: candidate.path,
      file_type: candidate.file_type,
      content: text,
      content_sha256: sha256(content),
      byte_count: content.byteLength,
      source_id: `repository:${candidate.path}`,
    });
    totalBytes += content.byteLength;
    byType.set(candidate.file_type, (byType.get(candidate.file_type) ?? 0) + 1);
  }
  return selected.sort((left, right) => left.path.localeCompare(right.path));
}

function prioritizeCandidates(
  candidates: Array<{ path: string; file_type: ScanFileType }>,
): Array<{ path: string; file_type: ScanFileType }> {
  const priority: Record<ScanFileType, number> = {
    documentation: 0,
    manifest: 1,
    configuration: 2,
    source_code: 3,
    test: 4,
    benchmark: 5,
  };
  return [...candidates].sort(
    (left, right) =>
      priority[left.file_type] - priority[right.file_type] ||
      left.path.localeCompare(right.path),
  );
}

export function isSensitivePath(path: string): boolean {
  return NON_OVERRIDABLE_SENSITIVE_PATHS.some((pattern) => pattern.test(path));
}

export function includesSensitiveMarker(content: string): boolean {
  const lowerContent = content.toLowerCase();
  return SECRET_MARKERS.some((marker) => lowerContent.includes(marker));
}

export const agent_source_limits = {
  max_file_bytes: MAX_AGENT_FILE_BYTES,
  max_total_bytes: MAX_AGENT_TOTAL_BYTES,
};

async function readStoredSourceFile(
  runPath: string,
  value: unknown,
  index: number,
): Promise<AgentSourceFile> {
  if (!isRecord(value)) {
    throw invalidSourceFile(runPath, index);
  }
  const path = value.path;
  const fileType = value.file_type;
  const contentSha256 = value.content_sha256;
  const byteCount = value.byte_count;
  const sourceId = value.source_id;
  if (
    typeof path !== "string" ||
    !isSafeRelativePath(path) ||
    !isScanFileType(fileType) ||
    typeof contentSha256 !== "string" ||
    typeof byteCount !== "number" ||
    typeof sourceId !== "string"
  ) {
    throw invalidSourceFile(runPath, index);
  }
  const sourcePath = artifactPath(runPath, `source/${path}`);
  let content: Buffer;
  try {
    await assertRealSourceFile(runPath, path);
    const metadata = await lstat(sourcePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_AGENT_FILE_BYTES
    ) {
      throw new Error("unsafe source artifact file");
    }
    content = await readFile(sourcePath);
  } catch {
    throw invalidSourceFile(runPath, index);
  }
  if (
    content.byteLength !== byteCount ||
    sha256(content) !== contentSha256 ||
    content.includes(0)
  ) {
    throw new PaperbotError(
      `agent source artifact content no longer matches its digest: ${path}`,
      ExitCode.io,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw invalidSourceFile(runPath, index);
  }
  return {
    path,
    file_type: fileType,
    content: text,
    content_sha256: contentSha256,
    byte_count: byteCount,
    source_id: sourceId,
  };
}

async function readStoredArtifactText(
  path: string,
  label: string,
  maximumBytes: number,
): Promise<string> {
  let content: Buffer;
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > maximumBytes
    ) {
      throw new Error("unsafe artifact");
    }
    content = await readFile(path);
  } catch {
    throw new PaperbotError(`could not read ${label}: ${path}`, ExitCode.io);
  }
  if (content.byteLength > maximumBytes) {
    throw new PaperbotError(
      `${label} exceeds its size limit: ${path}`,
      ExitCode.io,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new PaperbotError(
      `${label} is not valid UTF-8: ${path}`,
      ExitCode.io,
    );
  }
}

async function assertRealDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("unsafe directory");
    }
  } catch {
    throw new PaperbotError(
      `agent source artifact directory is unavailable: ${path}`,
      ExitCode.io,
    );
  }
}

async function assertRealSourceFile(
  runPath: string,
  path: string,
): Promise<void> {
  await assertRealDirectory(artifactPath(runPath, "source"));
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const currentPath = artifactPath(
      runPath,
      `source/${segments.slice(0, index + 1).join("/")}`,
    );
    try {
      const metadata = await lstat(currentPath);
      const isLastSegment = index === segments.length - 1;
      if (
        metadata.isSymbolicLink() ||
        (isLastSegment ? !metadata.isFile() : !metadata.isDirectory())
      ) {
        throw new Error("unsafe source artifact path");
      }
    } catch {
      throw invalidSourceArtifact(
        runPath,
        `source artifact path is unavailable: ${path}`,
      );
    }
  }
}

function readStoredUrl(value: string, label: string, runPath: string): string {
  try {
    return normalizeAnonymousHttpUrl(value, `agent source ${label}`);
  } catch {
    throw invalidSourceArtifact(runPath, `invalid ${label}`);
  }
}

function readStoredRevision(value: string, runPath: string): string {
  if (!SHA_PATTERN.test(value)) {
    throw invalidSourceArtifact(runPath, "invalid resolved_revision");
  }
  return value.toLowerCase();
}

function readStoredTimestamp(value: string, runPath: string): string {
  if (value.length > 64 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalidSourceArtifact(runPath, "invalid retrieved_at");
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw invalidSourceArtifact(runPath, "invalid retrieved_at");
  }
  return date.toISOString();
}

function validateRestoredSource(source: AgentSource, runPath: string): void {
  if (
    source.files.length === 0 ||
    source.files.length > MAX_AGENT_SOURCE_FILES ||
    source.scan_manifest.repository.revision !== source.resolved_revision ||
    source.scan_manifest.repository.is_dirty !== source.is_dirty ||
    (source.kind === "github" && source.is_dirty)
  ) {
    throw invalidSourceArtifact(
      runPath,
      "source snapshot metadata does not match",
    );
  }

  const scanFiles = new Map(
    source.scan_manifest.files.map((file) => [file.path, file.file_type]),
  );
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of source.files) {
    if (
      !isSafeRelativePath(file.path) ||
      isSensitivePath(file.path) ||
      file.source_id !== `repository:${file.path}` ||
      paths.has(file.path) ||
      file.byte_count > MAX_AGENT_FILE_BYTES ||
      file.byte_count < 0 ||
      file.content.includes("\u0000") ||
      includesSensitiveMarker(file.content) ||
      scanFiles.get(file.path) !== file.file_type
    ) {
      throw invalidSourceArtifact(
        runPath,
        `source file is outside the safe snapshot: ${file.path}`,
      );
    }
    totalBytes += file.byte_count;
    paths.add(file.path);
  }
  if (totalBytes > MAX_AGENT_TOTAL_BYTES) {
    throw invalidSourceArtifact(
      runPath,
      "source snapshot exceeds its byte limit",
    );
  }
}

function invalidSourceArtifact(
  runPath: string,
  message: string,
): PaperbotError {
  return new PaperbotError(
    `agent source artifact is unsafe (${message}): ${runPath}`,
    ExitCode.io,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    !path
      .split("/")
      .some((part) => part.length === 0 || part === "." || part === "..")
  );
}

function isScanFileType(value: unknown): value is ScanFileType {
  return (
    value === "source_code" ||
    value === "documentation" ||
    value === "test" ||
    value === "benchmark" ||
    value === "configuration" ||
    value === "manifest"
  );
}

function invalidSourceFile(runPath: string, index: number): PaperbotError {
  return new PaperbotError(
    `agent source artifact has an invalid file at index ${index}: ${runPath}`,
    ExitCode.io,
  );
}
