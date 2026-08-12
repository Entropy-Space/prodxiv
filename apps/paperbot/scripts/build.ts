import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { collectSourceBuildValues } from "../src/agent/provenance.ts";

const appRoot = resolve(import.meta.dir, "..");
const builtAt = new Date().toISOString();
const provenance = await collectSourceBuildValues(builtAt);
const outputPath =
  process.env.PAPERBOT_BUILD_OUTPUT?.trim() ||
  resolve(appRoot, "dist/paperbot");
await mkdir(dirname(outputPath), { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve(appRoot, "src/cli.ts")],
  target: "bun",
  compile: {
    outfile: outputPath,
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  define: {
    __PAPERBOT_BUILD_GIT_REVISION__: JSON.stringify(provenance.git_revision),
    __PAPERBOT_BUILD_GIT_DIRTY__: JSON.stringify(String(provenance.git_dirty)),
    __PAPERBOT_BUILD_SOURCE_STATE_SHA256__: JSON.stringify(
      provenance.source_state_sha256,
    ),
    __PAPERBOT_BUILD_DEPENDENCY_LOCK_SHA256__: JSON.stringify(
      provenance.dependency_lock_sha256,
    ),
    __PAPERBOT_BUILD_PROMPT_SET_SHA256__: JSON.stringify(
      provenance.prompt_set_sha256,
    ),
    __PAPERBOT_BUILD_ID__: JSON.stringify(provenance.build_id),
    __PAPERBOT_BUILT_AT__: JSON.stringify(builtAt),
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}
