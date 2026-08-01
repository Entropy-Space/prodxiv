import {
  chmod,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ExitCode, PaperbotError } from "@prodxiv/paperbot-core";

const RUN_DIRECTORY_MODE = 0o700;

export async function initializeRunDirectory(
  outputPath: string,
): Promise<string> {
  const runPath = resolve(outputPath);
  try {
    const metadata = await lstat(runPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new PaperbotError(
        `agent output must be a real directory: ${outputPath}`,
        ExitCode.io,
      );
    }
    const entries = await readdir(runPath);
    if (entries.length > 0) {
      throw new PaperbotError(
        `refusing to use a non-empty agent output directory: ${outputPath}`,
        ExitCode.io,
      );
    }
  } catch (error) {
    if (error instanceof PaperbotError) {
      throw error;
    }
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") {
      throw new PaperbotError(
        `could not inspect agent output directory: ${outputPath}`,
        ExitCode.io,
      );
    }
    try {
      await mkdir(runPath, { recursive: true, mode: RUN_DIRECTORY_MODE });
    } catch {
      throw new PaperbotError(
        `could not create agent output directory: ${outputPath}`,
        ExitCode.io,
      );
    }
  }

  try {
    await chmod(runPath, RUN_DIRECTORY_MODE);
  } catch {
    throw new PaperbotError(
      `could not secure agent output directory: ${outputPath}`,
      ExitCode.io,
    );
  }
  return runPath;
}

export async function ensureRunDirectory(runPath: string): Promise<string> {
  const absoluteRunPath = resolve(runPath);
  try {
    const metadata = await lstat(absoluteRunPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("not a real directory");
    }
  } catch {
    throw new PaperbotError(
      `agent run directory is not available: ${runPath}`,
      ExitCode.io,
    );
  }
  return absoluteRunPath;
}

export async function writeJsonArtifact(
  runPath: string,
  filename: string,
  value: unknown,
): Promise<string> {
  return writeTextArtifact(
    runPath,
    filename,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

export async function writeTextArtifact(
  runPath: string,
  filename: string,
  content: string,
): Promise<string> {
  const artifactPath = resolveArtifactPath(runPath, filename);
  await writeAtomically(artifactPath, content);
  return artifactPath;
}

export async function writeBinaryArtifact(
  runPath: string,
  filename: string,
  content: Uint8Array,
): Promise<string> {
  const artifactPath = resolveArtifactPath(runPath, filename);
  await writeAtomically(artifactPath, content);
  return artifactPath;
}

export function artifactPath(runPath: string, filename: string): string {
  return resolveArtifactPath(runPath, filename);
}

export function sha256(value: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function writeAtomically(
  targetPath: string,
  content: string | Uint8Array,
): Promise<void> {
  const directory = dirname(targetPath);
  try {
    await mkdir(directory, { recursive: true, mode: RUN_DIRECTORY_MODE });
    await chmod(directory, RUN_DIRECTORY_MODE);
  } catch {
    throw new PaperbotError(
      `could not create agent artifact directory: ${directory}`,
      ExitCode.io,
    );
  }

  const temporaryPath = join(directory, `.${crypto.randomUUID()}.paperbot-tmp`);
  try {
    await writeFile(temporaryPath, content, { mode: 0o600 });
    await rename(temporaryPath, targetPath);
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new PaperbotError(
      `could not write agent artifact: ${targetPath}`,
      ExitCode.io,
    );
  }
}

function resolveArtifactPath(runPath: string, filename: string): string {
  if (
    filename.length === 0 ||
    filename.startsWith("/") ||
    filename.split("/").some((part) => part === "..")
  ) {
    throw new PaperbotError(
      `invalid agent artifact path: ${filename}`,
      ExitCode.io,
    );
  }
  const root = resolve(runPath);
  const path = resolve(root, filename);
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new PaperbotError(
      `agent artifact escapes run directory: ${filename}`,
      ExitCode.io,
    );
  }
  return path;
}
