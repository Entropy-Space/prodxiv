/**
 * A deliberately narrow, read-only adapter for collecting evidence from a
 * public GitHub repository. It never shells out, accepts no arbitrary hosts,
 * and pins every fetched file to an immutable commit SHA.
 */

import { basename } from "node:path";

import type { ScanFileType } from "../scan-manifest.ts";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_RAW_ORIGIN = "https://raw.githubusercontent.com";
const GITHUB_API_VERSION = "2022-11-28";
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const MAX_REPOSITORY_NAME_LENGTH = 100;
const MAX_REF_LENGTH = 255;

const DOCUMENTATION_EXTENSIONS = new Set([".adoc", ".md", ".mdx", ".rst"]);
const SOURCE_EXTENSIONS = new Set([
  ".astro",
  ".bash",
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".php",
  ".proto",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
  ".zsh",
]);
const CONFIGURATION_EXTENSIONS = new Set([
  ".conf",
  ".ini",
  ".json",
  ".properties",
  ".toml",
  ".xml",
  ".yaml",
  ".yml",
]);
const MANIFEST_FILENAMES = new Set([
  "bun.lock",
  "cargo.lock",
  "cargo.toml",
  "composer.json",
  "composer.lock",
  "deno.json",
  "deno.jsonc",
  "gemfile",
  "gemfile.lock",
  "go.mod",
  "go.sum",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "yarn.lock",
]);
const CONFIGURATION_FILENAMES = new Set([
  ".dockerignore",
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  "containerfile",
  "dockerfile",
  "justfile",
  "makefile",
]);
const DOCUMENTATION_FILENAMES = new Set([
  "agents.md",
  "changelog",
  "changelog.md",
  "contributing.md",
  "license",
  "license.md",
  "readme",
  "readme.md",
]);
const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".astro",
  ".aws",
  ".next",
  ".secrets",
  ".turbo",
  "backup",
  "backups",
  "build",
  "coverage",
  "dist",
  "generated",
  "gen",
  "node_modules",
  "out",
  "secrets",
  "target",
  "uploads",
  "user_data",
  "userdata",
  "vendor",
]);

const DEFAULT_LIMITS: GitHubSourceLimits = {
  max_selected_files: 16,
  max_file_bytes: 128 * 1024,
  max_total_bytes: 768 * 1024,
  max_tree_entries: 50_000,
  max_metadata_bytes: 256 * 1024,
  max_commit_bytes: 256 * 1024,
  max_tree_bytes: 8 * 1024 * 1024,
};

export interface GitHubSourceLimits {
  max_selected_files: number;
  max_file_bytes: number;
  max_total_bytes: number;
  max_tree_entries: number;
  max_metadata_bytes: number;
  max_commit_bytes: number;
  max_tree_bytes: number;
}

export type GitHubSourceFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface GitHubSourceClientOptions {
  fetch?: GitHubSourceFetch;
  now?: () => Date;
  limits?: Partial<GitHubSourceLimits>;
}

export interface CanonicalGitHubRepository {
  owner: string;
  repository: string;
  canonical_url: string;
}

export interface GitHubSourceTreeFile {
  path: string;
  blob_sha: string;
  byte_count?: number;
  file_type?: ScanFileType;
}

export interface GitHubRepositorySnapshot {
  canonical_url: string;
  owner: string;
  repository: string;
  requested_ref?: string;
  resolved_ref: string;
  resolved_revision: string;
  homepage_url?: string;
  files: GitHubSourceTreeFile[];
}

export type GitHubSourceSkipReason =
  "excluded" | "unsupported" | "oversized" | "selection_limit";

export interface GitHubSourceSelection {
  selected_paths: string[];
  tree_file_count: number;
  skipped_file_counts: Record<GitHubSourceSkipReason, number>;
}

export interface GitHubSourceFile {
  path: string;
  file_type: ScanFileType;
  content: string;
  content_sha256: string;
  byte_count: number;
}

export interface GitHubSourceResult {
  canonical_url: string;
  requested_ref?: string;
  resolved_ref: string;
  resolved_revision: string;
  retrieved_at: string;
  homepage_url?: string;
  files: GitHubSourceFile[];
  selection: GitHubSourceSelection;
}

export interface InspectGitHubRepositoryOptions extends GitHubSourceClientOptions {
  repository_url: string;
  ref?: string;
}

export interface FetchGitHubSourceOptions extends InspectGitHubRepositoryOptions {
  selected_paths?: readonly string[];
}

export type GitHubSourceErrorCode =
  | "invalid_repository_url"
  | "invalid_ref"
  | "network_request_failed"
  | "repository_not_public"
  | "github_response_failed"
  | "invalid_github_response"
  | "truncated_tree"
  | "unsafe_tree_path"
  | "symlink_not_supported"
  | "submodule_not_supported"
  | "unsupported_tree_entry"
  | "tree_too_large"
  | "invalid_selection"
  | "no_selectable_files"
  | "content_limit_exceeded"
  | "non_text_content";

export class GitHubSourceError extends Error {
  readonly code: GitHubSourceErrorCode;

  constructor(code: GitHubSourceErrorCode, message: string) {
    super(message);
    this.name = "GitHubSourceError";
    this.code = code;
  }
}

/**
 * Parses the only repository URL shape this adapter will ever request.
 * URLs with a trailing slash, query string, fragment, userinfo, or another
 * host are intentionally rejected rather than normalized.
 */
export function canonicalizeGitHubRepositoryUrl(
  repositoryUrl: string,
): CanonicalGitHubRepository {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(repositoryUrl);
  if (match === null) {
    throw invalidRepositoryUrl();
  }

  const owner = match[1];
  const repositoryWithSuffix = match[2];
  if (owner === undefined || repositoryWithSuffix === undefined) {
    throw invalidRepositoryUrl();
  }

  const repository = repositoryWithSuffix.endsWith(".git")
    ? repositoryWithSuffix.slice(0, -4)
    : repositoryWithSuffix;
  if (!isGitHubOwner(owner) || !isGitHubRepositoryName(repository)) {
    throw invalidRepositoryUrl();
  }

  return {
    owner,
    repository,
    canonical_url: `https://github.com/${owner}/${repository}`,
  };
}

/**
 * Reads repository metadata, resolves a branch or tag to an immutable commit,
 * and verifies that every entry in the recursive tree is safe to inspect.
 */
export async function inspectGitHubRepository(
  options: InspectGitHubRepositoryOptions,
): Promise<GitHubRepositorySnapshot> {
  const repository = canonicalizeGitHubRepositoryUrl(options.repository_url);
  const fetch = options.fetch ?? defaultFetch;
  const limits = resolveLimits(options.limits);

  const metadata = await readJson(
    fetch,
    repositoryApiUrl(repository),
    "repository metadata",
    limits.max_metadata_bytes,
  );
  const defaultBranch = validateRepositoryMetadata(metadata);
  const requestedRef =
    options.ref === undefined ? undefined : validateRef(options.ref);
  const resolvedRef = requestedRef ?? defaultBranch;
  const revision = await resolveRevision(
    fetch,
    repository,
    resolvedRef,
    limits.max_commit_bytes,
  );
  const files = await loadTree(fetch, repository, revision, limits);

  return {
    canonical_url: repository.canonical_url,
    owner: repository.owner,
    repository: repository.repository,
    ...(requestedRef === undefined ? {} : { requested_ref: requestedRef }),
    resolved_ref: resolvedRef,
    resolved_revision: revision,
    ...homepageFromMetadata(metadata),
    files,
  };
}

/**
 * Selects a small, deterministic evidence bundle. It is intentionally not a
 * repository export: only recognized, non-sensitive, text-shaped paths are
 * eligible and the selection has a fixed cap.
 */
export function selectDefaultGitHubSourcePaths(
  snapshot: GitHubRepositorySnapshot,
  limits?: Partial<GitHubSourceLimits>,
): GitHubSourceSelection {
  const resolvedLimits = resolveLimits(limits);
  const skipped_file_counts = emptySkipCounts();
  const eligible = snapshot.files
    .filter((file) => {
      if (file.file_type === undefined) {
        skipped_file_counts.unsupported += 1;
        return false;
      }
      if (isExcludedSourcePath(file.path)) {
        skipped_file_counts.excluded += 1;
        return false;
      }
      if (
        file.byte_count !== undefined &&
        file.byte_count > resolvedLimits.max_file_bytes
      ) {
        skipped_file_counts.oversized += 1;
        return false;
      }
      return true;
    })
    .sort(compareSourcePriority);

  const selected = eligible.slice(0, resolvedLimits.max_selected_files);
  skipped_file_counts.selection_limit = eligible.length - selected.length;

  return {
    selected_paths: selected.map((file) => file.path),
    tree_file_count: snapshot.files.length,
    skipped_file_counts,
  };
}

/**
 * Fetches an explicit, already bounded list of files from raw.githubusercontent
 * at the exact commit returned by inspectGitHubRepository.
 */
export async function fetchGitHubSourceFiles(
  snapshot: GitHubRepositorySnapshot,
  selection: GitHubSourceSelection,
  options: GitHubSourceClientOptions = {},
): Promise<GitHubSourceResult> {
  const fetch = options.fetch ?? defaultFetch;
  const limits = resolveLimits(options.limits);
  const selectedFiles = resolveSelectedFiles(snapshot, selection, limits);
  const files: GitHubSourceFile[] = [];
  let totalBytes = 0;

  for (const selectedFile of selectedFiles) {
    const remainingBytes = limits.max_total_bytes - totalBytes;
    const maximumBytes = Math.min(limits.max_file_bytes, remainingBytes);
    if (maximumBytes <= 0) {
      throw new GitHubSourceError(
        "content_limit_exceeded",
        `selected content exceeds the ${limits.max_total_bytes}-byte total limit`,
      );
    }

    const response = await request(
      fetch,
      rawContentUrl(snapshot, selectedFile.path),
      "repository file",
    );
    if (!response.ok) {
      throw new GitHubSourceError(
        "github_response_failed",
        `GitHub repository file request failed with HTTP ${response.status}`,
      );
    }

    const bytes = await readResponseBytes(response, maximumBytes);
    if (gitBlobSha(bytes) !== selectedFile.blob_sha) {
      throw new GitHubSourceError(
        "invalid_github_response",
        `GitHub repository file did not match its tree blob SHA: ${selectedFile.path}`,
      );
    }
    if (bytes.includes(0)) {
      throw new GitHubSourceError(
        "non_text_content",
        `selected file is not text content: ${selectedFile.path}`,
      );
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new GitHubSourceError(
        "non_text_content",
        `selected file is not valid UTF-8 text: ${selectedFile.path}`,
      );
    }

    totalBytes += bytes.byteLength;
    files.push({
      path: selectedFile.path,
      file_type: selectedFile.file_type,
      content,
      content_sha256: await sha256(bytes),
      byte_count: bytes.byteLength,
    });
  }

  return {
    canonical_url: snapshot.canonical_url,
    ...(snapshot.requested_ref === undefined
      ? {}
      : { requested_ref: snapshot.requested_ref }),
    resolved_ref: snapshot.resolved_ref,
    resolved_revision: snapshot.resolved_revision,
    retrieved_at: (options.now ?? (() => new Date()))().toISOString(),
    ...(snapshot.homepage_url === undefined
      ? {}
      : { homepage_url: snapshot.homepage_url }),
    files,
    selection: {
      selected_paths: [...selection.selected_paths],
      tree_file_count: selection.tree_file_count,
      skipped_file_counts: selection.skipped_file_counts,
    },
  };
}

/**
 * Convenience operation for callers that want a full bounded source snapshot.
 * Explicit paths are never silently expanded; omitting them uses the fixed
 * default selection above.
 */
export async function fetchGitHubSource(
  options: FetchGitHubSourceOptions,
): Promise<GitHubSourceResult> {
  const snapshot = await inspectGitHubRepository(options);
  const limits = resolveLimits(options.limits);
  const selection =
    options.selected_paths === undefined
      ? selectDefaultGitHubSourcePaths(snapshot, limits)
      : explicitSelection(snapshot, options.selected_paths, limits);

  if (selection.selected_paths.length === 0) {
    throw new GitHubSourceError(
      "no_selectable_files",
      "repository has no eligible files for a bounded Paperbot source snapshot",
    );
  }

  return fetchGitHubSourceFiles(snapshot, selection, options);
}

function invalidRepositoryUrl(): GitHubSourceError {
  return new GitHubSourceError(
    "invalid_repository_url",
    "repository_url must be https://github.com/<owner>/<repo> or end in .git, with no query, fragment, userinfo, or trailing slash",
  );
}

function isGitHubOwner(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?$/.test(value);
}

function isGitHubRepositoryName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_REPOSITORY_NAME_LENGTH &&
    value !== "." &&
    value !== ".." &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function validateRef(value: string): string {
  if (
    value.length === 0 ||
    value.length > MAX_REF_LENGTH ||
    value === "." ||
    value === "@" ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\u0000-\u001f\u007f~^:?*[\\\s]/.test(value)
  ) {
    throw new GitHubSourceError(
      "invalid_ref",
      "ref must be a safe Git branch, tag, or commit reference",
    );
  }
  return value;
}

function resolveLimits(
  overrides: Partial<GitHubSourceLimits> | undefined,
): GitHubSourceLimits {
  const limits: GitHubSourceLimits = {
    ...DEFAULT_LIMITS,
    ...overrides,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new GitHubSourceError(
        "invalid_selection",
        `${name} must be a positive safe integer`,
      );
    }
  }
  if (limits.max_file_bytes > limits.max_total_bytes) {
    throw new GitHubSourceError(
      "invalid_selection",
      "max_file_bytes cannot exceed max_total_bytes",
    );
  }
  return limits;
}

async function resolveRevision(
  fetch: GitHubSourceFetch,
  repository: CanonicalGitHubRepository,
  ref: string,
  maxBytes: number,
): Promise<string> {
  const value = await readJson(
    fetch,
    `${repositoryApiUrl(repository)}/commits/${encodeURIComponent(ref)}`,
    "commit resolution",
    maxBytes,
  );
  if (
    !isRecord(value) ||
    typeof value.sha !== "string" ||
    !SHA_PATTERN.test(value.sha)
  ) {
    throw new GitHubSourceError(
      "invalid_github_response",
      "GitHub commit response did not include an exact commit SHA",
    );
  }
  return value.sha.toLowerCase();
}

async function loadTree(
  fetch: GitHubSourceFetch,
  repository: CanonicalGitHubRepository,
  revision: string,
  limits: GitHubSourceLimits,
): Promise<GitHubSourceTreeFile[]> {
  const value = await readJson(
    fetch,
    `${repositoryApiUrl(repository)}/git/trees/${revision}?recursive=1`,
    "recursive tree",
    limits.max_tree_bytes,
  );
  if (
    !isRecord(value) ||
    value.truncated !== false ||
    !Array.isArray(value.tree)
  ) {
    if (isRecord(value) && value.truncated === true) {
      throw new GitHubSourceError(
        "truncated_tree",
        "GitHub returned a truncated recursive tree; Paperbot will not analyze a partial source snapshot",
      );
    }
    throw new GitHubSourceError(
      "invalid_github_response",
      "GitHub recursive tree response was invalid",
    );
  }
  if (value.tree.length > limits.max_tree_entries) {
    throw new GitHubSourceError(
      "tree_too_large",
      `repository tree exceeds the ${limits.max_tree_entries}-entry limit`,
    );
  }

  const paths = new Set<string>();
  const files: GitHubSourceTreeFile[] = [];
  for (const entry of value.tree) {
    const parsed = parseTreeEntry(entry);
    if (paths.has(parsed.path)) {
      throw new GitHubSourceError(
        "unsafe_tree_path",
        `GitHub recursive tree contains duplicate path: ${parsed.path}`,
      );
    }
    paths.add(parsed.path);
    if (parsed.kind === "file") {
      const fileType = classifyGitHubSourcePath(parsed.path);
      files.push({
        path: parsed.path,
        blob_sha: parsed.blob_sha,
        ...(parsed.byte_count === undefined
          ? {}
          : { byte_count: parsed.byte_count }),
        ...(fileType === undefined ? {} : { file_type: fileType }),
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

type ParsedTreeEntry =
  | {
      kind: "directory";
      path: string;
    }
  | {
      kind: "file";
      path: string;
      blob_sha: string;
      byte_count?: number;
    };

function parseTreeEntry(value: unknown): ParsedTreeEntry {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    typeof value.type !== "string"
  ) {
    throw new GitHubSourceError(
      "invalid_github_response",
      "GitHub recursive tree contains an invalid entry",
    );
  }
  if (!isSafeGitHubPath(value.path)) {
    throw new GitHubSourceError(
      "unsafe_tree_path",
      `GitHub recursive tree contains an unsafe path: ${value.path}`,
    );
  }
  if (value.type === "commit" || value.mode === "160000") {
    throw new GitHubSourceError(
      "submodule_not_supported",
      `GitHub repository contains a submodule: ${value.path}`,
    );
  }
  if (value.type === "blob" && value.mode === "120000") {
    throw new GitHubSourceError(
      "symlink_not_supported",
      `GitHub repository contains a symbolic link: ${value.path}`,
    );
  }
  if (value.type === "tree") {
    if (value.mode !== "040000" && value.mode !== "40000") {
      throw new GitHubSourceError(
        "unsupported_tree_entry",
        `GitHub repository contains an unsupported tree entry: ${value.path}`,
      );
    }
    return { kind: "directory", path: value.path };
  }
  if (
    value.type !== "blob" ||
    (value.mode !== "100644" && value.mode !== "100755")
  ) {
    throw new GitHubSourceError(
      "unsupported_tree_entry",
      `GitHub repository contains an unsupported tree entry: ${value.path}`,
    );
  }
  if (typeof value.sha !== "string" || !SHA_PATTERN.test(value.sha)) {
    throw new GitHubSourceError(
      "invalid_github_response",
      `GitHub recursive tree entry has an invalid blob SHA: ${value.path}`,
    );
  }
  let byteCount: number | undefined;
  if (value.size !== undefined) {
    if (
      typeof value.size !== "number" ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0
    ) {
      throw new GitHubSourceError(
        "invalid_github_response",
        `GitHub recursive tree entry has an invalid size: ${value.path}`,
      );
    }
    byteCount = value.size;
  }
  return {
    kind: "file",
    path: value.path,
    blob_sha: value.sha.toLowerCase(),
    ...(byteCount === undefined ? {} : { byte_count: byteCount }),
  };
}

function isSafeGitHubPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 4096 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      segment !== ".git",
  );
}

function explicitSelection(
  snapshot: GitHubRepositorySnapshot,
  paths: readonly string[],
  limits: GitHubSourceLimits,
): GitHubSourceSelection {
  if (paths.length === 0 || paths.length > limits.max_selected_files) {
    throw new GitHubSourceError(
      "invalid_selection",
      `selected_paths must contain between 1 and ${limits.max_selected_files} files`,
    );
  }
  const selected_paths = [...paths].sort((left, right) =>
    left.localeCompare(right),
  );
  const uniquePaths = new Set(selected_paths);
  if (uniquePaths.size !== selected_paths.length) {
    throw new GitHubSourceError(
      "invalid_selection",
      "selected_paths must not contain duplicates",
    );
  }

  const filesByPath = new Map(snapshot.files.map((file) => [file.path, file]));
  for (const path of selected_paths) {
    const file = filesByPath.get(path);
    if (file === undefined || !isSafeGitHubPath(path)) {
      throw new GitHubSourceError(
        "invalid_selection",
        `selected path is not a safe repository file: ${path}`,
      );
    }
    if (file.file_type === undefined || isExcludedSourcePath(path)) {
      throw new GitHubSourceError(
        "invalid_selection",
        `selected path is not eligible for Paperbot source analysis: ${path}`,
      );
    }
    if (
      file.byte_count !== undefined &&
      file.byte_count > limits.max_file_bytes
    ) {
      throw new GitHubSourceError(
        "invalid_selection",
        `selected path exceeds the per-file byte limit: ${path}`,
      );
    }
  }

  return {
    selected_paths,
    tree_file_count: snapshot.files.length,
    skipped_file_counts: emptySkipCounts(),
  };
}

function resolveSelectedFiles(
  snapshot: GitHubRepositorySnapshot,
  selection: GitHubSourceSelection,
  limits: GitHubSourceLimits,
): Array<GitHubSourceTreeFile & { file_type: ScanFileType }> {
  if (
    selection.selected_paths.length === 0 ||
    selection.selected_paths.length > limits.max_selected_files
  ) {
    throw new GitHubSourceError(
      "invalid_selection",
      `selected_paths must contain between 1 and ${limits.max_selected_files} files`,
    );
  }
  const filesByPath = new Map(snapshot.files.map((file) => [file.path, file]));
  const selected: Array<GitHubSourceTreeFile & { file_type: ScanFileType }> =
    [];
  const paths = [...selection.selected_paths].sort((left, right) =>
    left.localeCompare(right),
  );
  const uniquePaths = new Set(paths);
  if (uniquePaths.size !== paths.length) {
    throw new GitHubSourceError(
      "invalid_selection",
      "selected_paths must not contain duplicates",
    );
  }
  for (const path of paths) {
    const file = filesByPath.get(path);
    if (
      file === undefined ||
      file.file_type === undefined ||
      !isSafeGitHubPath(path) ||
      isExcludedSourcePath(path)
    ) {
      throw new GitHubSourceError(
        "invalid_selection",
        `selected path is not eligible for Paperbot source analysis: ${path}`,
      );
    }
    if (
      file.byte_count !== undefined &&
      file.byte_count > limits.max_file_bytes
    ) {
      throw new GitHubSourceError(
        "invalid_selection",
        `selected path exceeds the per-file byte limit: ${path}`,
      );
    }
    selected.push({ ...file, file_type: file.file_type });
  }
  return selected;
}

function emptySkipCounts(): Record<GitHubSourceSkipReason, number> {
  return {
    excluded: 0,
    unsupported: 0,
    oversized: 0,
    selection_limit: 0,
  };
}

function compareSourcePriority(
  left: GitHubSourceTreeFile,
  right: GitHubSourceTreeFile,
): number {
  const priority = sourcePriority(left) - sourcePriority(right);
  return priority === 0 ? left.path.localeCompare(right.path) : priority;
}

function sourcePriority(file: GitHubSourceTreeFile): number {
  const lowerPath = file.path.toLowerCase();
  const filename = basename(lowerPath);
  const depth = lowerPath.split("/").length;
  if (depth === 1 && (filename === "readme" || filename === "readme.md")) {
    return 0;
  }
  if (file.file_type === "documentation") {
    return 10 + depth;
  }
  if (file.file_type === "manifest") {
    return 20 + depth;
  }
  if (file.file_type === "configuration") {
    return 30 + depth;
  }
  if (file.file_type === "source_code") {
    return 40 + depth;
  }
  if (file.file_type === "test") {
    return 50 + depth;
  }
  return 60 + depth;
}

export function classifyGitHubSourcePath(
  path: string,
): ScanFileType | undefined {
  const lowerPath = path.toLowerCase();
  const filename = basename(lowerPath);
  const extensionIndex = filename.lastIndexOf(".");
  const extension = extensionIndex === -1 ? "" : filename.slice(extensionIndex);
  const segments = lowerPath.split("/");

  if (
    segments.some(
      (segment) =>
        segment === "bench" ||
        segment === "benches" ||
        segment === "benchmarks",
    ) ||
    /(?:^|[._-])bench(?:mark)?(?:[._-]|$)/.test(filename)
  ) {
    return "benchmark";
  }
  if (
    segments.some(
      (segment) =>
        segment === "test" || segment === "tests" || segment === "__tests__",
    ) ||
    /(?:^|[._-])(?:spec|test)(?:[._-]|$)/.test(filename)
  ) {
    return "test";
  }
  if (
    DOCUMENTATION_FILENAMES.has(filename) ||
    DOCUMENTATION_EXTENSIONS.has(extension) ||
    segments.includes("docs")
  ) {
    return "documentation";
  }
  if (MANIFEST_FILENAMES.has(filename)) {
    return "manifest";
  }
  if (
    CONFIGURATION_FILENAMES.has(filename) ||
    filename === ".env" ||
    filename.startsWith(".env.") ||
    CONFIGURATION_EXTENSIONS.has(extension) ||
    segments.includes(".github") ||
    segments.includes("config")
  ) {
    return "configuration";
  }
  if (SOURCE_EXTENSIONS.has(extension)) {
    return "source_code";
  }
  return undefined;
}

function isExcludedSourcePath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  const filename = basename(lowerPath);
  const segments = lowerPath.split("/");
  return (
    filename === ".env" ||
    filename.startsWith(".env.") ||
    filename === ".envrc" ||
    filename === ".npmrc" ||
    filename === ".pypirc" ||
    filename === "credentials" ||
    filename.startsWith("credentials.") ||
    filename === "secret" ||
    filename.startsWith("secret.") ||
    filename.endsWith(".pem") ||
    filename.endsWith(".key") ||
    filename.endsWith(".p12") ||
    filename.endsWith(".pfx") ||
    filename.endsWith(".db") ||
    filename.endsWith(".sqlite") ||
    filename.endsWith(".sqlite3") ||
    filename.startsWith("id_dsa") ||
    filename.startsWith("id_ecdsa") ||
    filename.startsWith("id_ed25519") ||
    filename.startsWith("id_rsa") ||
    segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))
  );
}

function validateRepositoryMetadata(value: unknown): string {
  if (
    !isRecord(value) ||
    value.private !== false ||
    value.visibility !== "public"
  ) {
    throw new GitHubSourceError(
      "repository_not_public",
      "Paperbot only accepts publicly visible GitHub repositories",
    );
  }
  if (typeof value.default_branch !== "string") {
    throw new GitHubSourceError(
      "invalid_github_response",
      "GitHub repository metadata did not include a default branch",
    );
  }
  return validateRef(value.default_branch);
}

function homepageFromMetadata(value: unknown): { homepage_url?: string } {
  if (!isRecord(value) || typeof value.homepage !== "string") {
    return {};
  }
  const homepage = value.homepage.trim();
  if (homepage.length === 0) {
    return {};
  }
  try {
    const url = new URL(homepage);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return {};
    }
    return { homepage_url: url.toString() };
  } catch {
    return {};
  }
}

function repositoryApiUrl(repository: CanonicalGitHubRepository): string {
  return `${GITHUB_API_ORIGIN}/repos/${repository.owner}/${repository.repository}`;
}

function rawContentUrl(
  snapshot: GitHubRepositorySnapshot,
  path: string,
): string {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${GITHUB_RAW_ORIGIN}/${snapshot.owner}/${snapshot.repository}/${snapshot.resolved_revision}/${encodedPath}`;
}

function gitBlobSha(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha1")
    .update(`blob ${bytes.byteLength}\u0000`)
    .update(bytes)
    .digest("hex");
}

async function readJson(
  fetch: GitHubSourceFetch,
  url: string,
  operation: string,
  maxBytes: number,
): Promise<unknown> {
  const response = await request(fetch, url, operation);
  if (!response.ok) {
    throw new GitHubSourceError(
      "github_response_failed",
      `GitHub ${operation} request failed with HTTP ${response.status}`,
    );
  }
  const bytes = await readResponseBytes(response, maxBytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new GitHubSourceError(
      "invalid_github_response",
      `GitHub ${operation} response was not valid UTF-8 JSON`,
    );
  }
}

async function request(
  fetch: GitHubSourceFetch,
  url: string,
  operation: string,
): Promise<Response> {
  try {
    return await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "prodxiv-paperbot",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      redirect: "error",
    });
  } catch {
    throw new GitHubSourceError(
      "network_request_failed",
      `GitHub ${operation} request could not be completed`,
    );
  }
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const declaredLength = Number(contentLength);
    if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) {
      throw contentLimitError(maxBytes);
    }
  }

  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      byteCount += chunk.value.byteLength;
      if (byteCount > maxBytes) {
        await reader.cancel();
        throw contentLimitError(maxBytes);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function contentLimitError(maxBytes: number): GitHubSourceError {
  return new GitHubSourceError(
    "content_limit_exceeded",
    `GitHub response exceeds the ${maxBytes}-byte content limit`,
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const defaultFetch: GitHubSourceFetch = (url, init) => fetch(url, init);
