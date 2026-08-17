import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareEvaluationManifest } from "./prepare-manifest.ts";

test("selects exactly three discovery projects", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "paperbot-evaluation-"));
  const selectionPath = join(workspace, "selection.json");
  await writeFile(
    selectionPath,
    JSON.stringify({
      selected_repositories: [
        { repository_full_name: "example/one" },
        { repository_full_name: "example/two" },
        { repository_full_name: "example/three" },
        { repository_full_name: "example/four" },
      ],
    }),
  );

  const manifest = await prepareEvaluationManifest(selectionPath);

  expect(manifest.projects).toEqual([
    { repository_url: "https://github.com/example/one" },
    { repository_url: "https://github.com/example/two" },
    { repository_url: "https://github.com/example/three" },
  ]);
});

test("skips repositories already covered by the current Paperbot version", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "paperbot-evaluation-"));
  const selectionPath = join(workspace, "selection.json");
  await writeFile(
    selectionPath,
    JSON.stringify({
      selected_repositories: [
        { repository_full_name: "example/one" },
        { repository_full_name: "example/two" },
        { repository_full_name: "example/three" },
        { repository_full_name: "example/four" },
      ],
    }),
  );

  const manifest = await prepareEvaluationManifest(
    selectionPath,
    new Set(["example/two"]),
  );

  expect(manifest.projects).toEqual([
    { repository_url: "https://github.com/example/one" },
    { repository_url: "https://github.com/example/three" },
    { repository_url: "https://github.com/example/four" },
  ]);
});
