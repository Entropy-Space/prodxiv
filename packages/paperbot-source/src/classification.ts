import { basename } from "node:path";

import type { ScanFileType } from "@prodxiv/paperbot-core";

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
  ".zig",
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

export function classifySourcePath(path: string): ScanFileType | undefined {
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
