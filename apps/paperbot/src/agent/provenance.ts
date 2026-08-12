import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256 } from "./artifacts.ts";
import { PAPERBOT_PROMPT_SET_VERSION } from "./prompts.ts";
import {
  AGENT_RUN_SCHEMA_VERSION,
  type AgentProducerProvenance,
} from "./types.ts";
import { PAPERBOT_VERSION } from "../version.ts";

declare const __PAPERBOT_BUILD_GIT_REVISION__: string;
declare const __PAPERBOT_BUILD_GIT_DIRTY__: string;
declare const __PAPERBOT_BUILD_SOURCE_STATE_SHA256__: string;
declare const __PAPERBOT_BUILD_DEPENDENCY_LOCK_SHA256__: string;
declare const __PAPERBOT_BUILD_PROMPT_SET_SHA256__: string;
declare const __PAPERBOT_BUILD_ID__: string;
declare const __PAPERBOT_BUILT_AT__: string;

export interface ProducerBuildValues {
  git_revision: string;
  git_dirty: boolean;
  source_state_sha256: string;
  dependency_lock_sha256: string;
  prompt_set_sha256: string;
  build_id: string;
  built_at?: string;
}

let sourceProvenance: Promise<AgentProducerProvenance> | undefined;

export function resolveProducerProvenance(): Promise<AgentProducerProvenance> {
  const embedded = embeddedBuildValues();
  if (embedded !== undefined) {
    return Promise.resolve(provenanceFromBuildValues(embedded));
  }
  if (Bun.embeddedFiles.length > 0) {
    return Promise.resolve(
      provenanceFromBuildValues({
        git_revision: "unavailable",
        git_dirty: true,
        source_state_sha256: sha256("unversioned-compiled-paperbot"),
        dependency_lock_sha256: sha256("unavailable"),
        prompt_set_sha256: sha256(PAPERBOT_PROMPT_SET_VERSION),
        build_id: sha256(
          `unversioned-compiled-paperbot:${PAPERBOT_VERSION}:${Bun.version}`,
        ),
      }),
    );
  }
  sourceProvenance ??= collectSourceBuildValues().then(
    provenanceFromBuildValues,
  );
  return sourceProvenance;
}

export async function collectSourceBuildValues(
  builtAt?: string,
): Promise<ProducerBuildValues> {
  const repositoryRoot = resolve(import.meta.dir, "../../../../");
  const [gitRevisionResult, gitDiffResult, untrackedResult, lock, prompts] =
    await Promise.all([
      runGit(repositoryRoot, ["rev-parse", "HEAD"]),
      runGit(repositoryRoot, ["diff", "--binary", "HEAD"]),
      runGit(repositoryRoot, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]),
      readFile(resolve(repositoryRoot, "bun.lock")),
      readFile(resolve(import.meta.dir, "prompts.ts")),
    ]);
  const gitRevision = gitRevisionResult.ok
    ? gitRevisionResult.output.trim().toLowerCase()
    : "unavailable";
  const untrackedPaths = untrackedResult.ok
    ? untrackedResult.output
        .split("\0")
        .filter((path) => path.length > 0)
        .sort()
    : [];
  const untracked = await Promise.all(
    untrackedPaths.map(async (path) => ({
      path,
      sha256: sha256(await readFile(resolve(repositoryRoot, path))),
    })),
  );
  const diff = gitDiffResult.ok ? gitDiffResult.output : "git diff unavailable";
  const gitDirty =
    !gitRevisionResult.ok ||
    !gitDiffResult.ok ||
    !untrackedResult.ok ||
    diff.length > 0 ||
    untracked.length > 0;
  const dependencyLockSha256 = sha256(lock);
  const promptSetSha256 = sha256(prompts);
  const sourceStateSha256 = sha256(
    JSON.stringify({
      git_revision: gitRevision,
      git_diff_sha256: sha256(diff),
      untracked,
    }),
  );
  const buildId = sha256(
    JSON.stringify({
      version: PAPERBOT_VERSION,
      git_revision: gitRevision,
      git_dirty: gitDirty,
      source_state_sha256: sourceStateSha256,
      bun_version: Bun.version,
      dependency_lock_sha256: dependencyLockSha256,
      run_schema_version: AGENT_RUN_SCHEMA_VERSION,
      prompt_set_version: PAPERBOT_PROMPT_SET_VERSION,
      prompt_set_sha256: promptSetSha256,
    }),
  );
  return {
    git_revision: gitRevision,
    git_dirty: gitDirty,
    source_state_sha256: sourceStateSha256,
    dependency_lock_sha256: dependencyLockSha256,
    prompt_set_sha256: promptSetSha256,
    build_id: buildId,
    ...(builtAt === undefined ? {} : { built_at: builtAt }),
  };
}

function provenanceFromBuildValues(
  values: ProducerBuildValues,
): AgentProducerProvenance {
  return {
    name: "paperbot",
    version: PAPERBOT_VERSION,
    git_revision: values.git_revision,
    git_dirty: values.git_dirty,
    source_state_sha256: values.source_state_sha256,
    build_id: values.build_id,
    bun_version: Bun.version,
    dependency_lock_sha256: values.dependency_lock_sha256,
    run_schema_version: AGENT_RUN_SCHEMA_VERSION,
    prompt_set_version: PAPERBOT_PROMPT_SET_VERSION,
    prompt_set_sha256: values.prompt_set_sha256,
    ...(values.built_at === undefined ? {} : { built_at: values.built_at }),
  };
}

function embeddedBuildValues(): ProducerBuildValues | undefined {
  if (typeof __PAPERBOT_BUILD_ID__ === "undefined") {
    return undefined;
  }
  return {
    git_revision: __PAPERBOT_BUILD_GIT_REVISION__,
    git_dirty: __PAPERBOT_BUILD_GIT_DIRTY__ === "true",
    source_state_sha256: __PAPERBOT_BUILD_SOURCE_STATE_SHA256__,
    dependency_lock_sha256: __PAPERBOT_BUILD_DEPENDENCY_LOCK_SHA256__,
    prompt_set_sha256: __PAPERBOT_BUILD_PROMPT_SET_SHA256__,
    build_id: __PAPERBOT_BUILD_ID__,
    built_at: __PAPERBOT_BUILT_AT__,
  };
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; output: string }> {
  try {
    const process = Bun.spawn(["git", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [exitCode, output] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
    ]);
    return { ok: exitCode === 0, output };
  } catch {
    return { ok: false, output: "" };
  }
}
