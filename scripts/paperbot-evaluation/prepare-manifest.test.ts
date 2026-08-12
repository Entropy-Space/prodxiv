import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareEvaluationManifest } from "./prepare-manifest.ts";

test("combines pinned canaries with three non-canary discovery projects", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "paperbot-evaluation-"));
  const canariesPath = join(workspace, "canaries.json");
  const selectionPath = join(workspace, "selection.json");
  await writeFile(
    canariesPath,
    JSON.stringify({
      schema_version: "1",
      projects: [
        project("different-ai/openwork", "a"),
        project("tigerbeetle/tigerbeetle", "b"),
        project("zhaoxuya520/reverse-skill", "c"),
      ],
    }),
  );
  await writeFile(
    selectionPath,
    JSON.stringify({
      selected_repositories: [
        { repository_full_name: "different-ai/openwork" },
        { repository_full_name: "example/one" },
        { repository_full_name: "example/two" },
        { repository_full_name: "example/three" },
      ],
    }),
  );

  const manifest = await prepareEvaluationManifest(canariesPath, selectionPath);

  expect(manifest.projects).toHaveLength(6);
  expect(manifest.projects.slice(3)).toEqual([
    { repository_url: "https://github.com/example/one" },
    { repository_url: "https://github.com/example/two" },
    { repository_url: "https://github.com/example/three" },
  ]);
});

function project(name: string, revisionCharacter: string) {
  return {
    repository_url: `https://github.com/${name}`,
    ref: revisionCharacter.repeat(40),
  };
}
