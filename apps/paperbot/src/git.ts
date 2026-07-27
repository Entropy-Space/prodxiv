import { realpath, stat } from "node:fs/promises";

import { ExitCode, PaperbotError } from "./errors.ts";

interface GitResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export interface GitRepository {
  root_path: string;
  revision: string;
  is_dirty: boolean;
  source_url?: string;
  files: string[];
}

export async function inspectGitRepository(
  path: string,
): Promise<GitRepository> {
  let requestedPath: string;
  try {
    requestedPath = await realpath(path);
    const metadata = await stat(requestedPath);
    if (!metadata.isDirectory()) {
      throw new Error("path is not a directory");
    }
  } catch {
    throw new PaperbotError(
      `repository path is not a readable directory: ${path}`,
      ExitCode.repository,
    );
  }

  const rootResult = await runGit(requestedPath, [
    "rev-parse",
    "--show-toplevel",
  ]);
  if (rootResult.exit_code !== 0) {
    throw new PaperbotError(
      `not a Git repository: ${path}`,
      ExitCode.repository,
    );
  }
  const root_path = await realpath(rootResult.stdout.trim());

  const [revisionResult, statusResult, remoteResult, filesResult] =
    await Promise.all([
      runGit(root_path, ["rev-parse", "HEAD"]),
      runGit(root_path, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=normal",
      ]),
      runGit(root_path, ["config", "--get", "remote.origin.url"]),
      runGit(root_path, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ]),
    ]);

  if (revisionResult.exit_code !== 0) {
    throw new PaperbotError(
      "repository must have at least one commit before it can be scanned",
      ExitCode.repository,
    );
  }
  if (statusResult.exit_code !== 0 || filesResult.exit_code !== 0) {
    throw new PaperbotError(
      "Git could not enumerate the repository",
      ExitCode.scan,
    );
  }

  const source_url =
    remoteResult.exit_code === 0
      ? sanitizeRemoteUrl(remoteResult.stdout.trim())
      : undefined;

  return {
    root_path,
    revision: revisionResult.stdout.trim(),
    is_dirty: statusResult.stdout.length > 0,
    ...(source_url === undefined ? {} : { source_url }),
    files: filesResult.stdout
      .split("\0")
      .filter((file) => file.length > 0)
      .sort(),
  };
}

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  const process = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit_code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exit_code, stdout, stderr };
}

function sanitizeRemoteUrl(remote: string): string | undefined {
  if (remote.length === 0) {
    return undefined;
  }

  const scpStyle = remote.match(/^git@([^:]+):(.+)$/);
  if (scpStyle !== null) {
    const [, host, path] = scpStyle;
    return host === undefined || path === undefined
      ? undefined
      : `https://${host}/${path.replace(/\.git$/, "")}`;
  }

  if (remote.startsWith("ssh://")) {
    try {
      const parsed = new URL(remote);
      return `https://${parsed.hostname}${parsed.pathname.replace(/\.git$/, "")}`;
    } catch {
      return undefined;
    }
  }

  try {
    const parsed = new URL(remote);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    parsed.search = "";
    return parsed
      .toString()
      .replace(/\/$/, "")
      .replace(/\.git$/, "");
  } catch {
    return undefined;
  }
}
