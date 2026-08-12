import { describe, expect, test } from "bun:test";

import { completeAgentMetadata } from "../src/agent/metadata.ts";
import type {
  AgentGitHubRelease,
  AgentProducerProvenance,
  AgentSource,
} from "../src/agent/types.ts";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const OBSERVED_AT = "2026-08-05T00:00:00.000Z";

describe("completeAgentMetadata", () => {
  test("attributes the GitHub owner and prefers stable release evidence", () => {
    const metadata = completeAgentMetadata(
      { title: "Product paper", product_name: "Product" },
      githubSource([
        release("v2.0.0-rc.1", true, "2026-08-04T00:00:00.000Z"),
        release("v1.0.0", false, "2026-08-01T00:00:00.000Z"),
      ]),
      "deepseek-v4-flash",
      OBSERVED_AT,
      producer(),
      "00000000-0000-4000-8000-000000000001",
    );

    expect(metadata).toMatchObject({
      authors: [
        {
          id: "github:example",
          kind: "organization",
          name: "example",
          url: "https://github.com/example",
        },
      ],
      writers: [
        {
          kind: "agent",
          name: "paperbot",
          model: "deepseek-v4-flash",
        },
      ],
      status: {
        value: "launched",
        determination: "inferred",
        confidence: "high",
        observed_at: OBSERVED_AT,
        evidence: [{ kind: "github_release", tag: "v1.0.0" }],
      },
    });
  });

  test("treats an explicit prerelease as public beta", () => {
    const metadata = completeAgentMetadata(
      { title: "Product paper", product_name: "Product" },
      githubSource([
        release("v1.0.0-beta.2", false, "2026-08-04T00:00:00.000Z"),
      ]),
      "model",
      OBSERVED_AT,
      producer(),
      "00000000-0000-4000-8000-000000000001",
    );

    expect(metadata.status).toMatchObject({
      value: "public_beta",
      determination: "inferred",
      confidence: "medium",
      evidence: [{ tag: "v1.0.0-beta.2" }],
    });
  });

  test("keeps status unknown when no release supports an inference", () => {
    const metadata = completeAgentMetadata(
      { title: "Product paper", product_name: "Product" },
      githubSource([]),
      "model",
      OBSERVED_AT,
      producer(),
      "00000000-0000-4000-8000-000000000001",
    );

    expect(metadata.status).toEqual({
      value: "unknown",
      determination: "unverified",
      confidence: "low",
    });
  });

  test("uses explicit author and status overrides without commit attribution", () => {
    const metadata = completeAgentMetadata(
      {
        title: "Product paper",
        product_name: "Product",
        authors: ["Human Author"],
        status: "private_beta",
      },
      githubSource([release("v1.0.0", false, OBSERVED_AT)]),
      "model",
      OBSERVED_AT,
      producer(),
      "00000000-0000-4000-8000-000000000001",
    );

    expect(metadata.authors).toEqual([
      { kind: "person", name: "Human Author" },
    ]);
    expect(metadata.status).toEqual({
      value: "private_beta",
      determination: "declared",
      confidence: "high",
      observed_at: OBSERVED_AT,
    });
  });

  test("requires an explicit author for a local repository without GitHub ownership", () => {
    const source = githubSource([]);
    source.kind = "local";
    source.canonical_url = "https://git.example.test/team/product";
    source.scan_manifest.repository.source_url = source.canonical_url;
    delete source.github_releases;

    expect(() =>
      completeAgentMetadata(
        { title: "Product paper", product_name: "Product" },
        source,
        "model",
        OBSERVED_AT,
        producer(),
        "00000000-0000-4000-8000-000000000001",
      ),
    ).toThrow("provide --author explicitly");
  });
});

function producer(): AgentProducerProvenance {
  return {
    name: "paperbot",
    version: "0.0.1",
    git_revision: "a".repeat(40),
    git_dirty: false,
    source_state_sha256: "b".repeat(64),
    build_id: "c".repeat(64),
    bun_version: Bun.version,
    dependency_lock_sha256: "d".repeat(64),
    run_schema_version: "4",
    prompt_set_version: "2",
    prompt_set_sha256: "e".repeat(64),
  };
}

function githubSource(releases: AgentGitHubRelease[]): AgentSource {
  return {
    kind: "github",
    canonical_url: "https://github.com/example/product",
    resolved_revision: REVISION,
    is_dirty: false,
    retrieved_at: OBSERVED_AT,
    github_releases: {
      retrieved_at: OBSERVED_AT,
      releases,
    },
    files: [
      {
        path: "README.md",
        file_type: "documentation",
        content: "# Product\n",
        content_sha256: "a".repeat(64),
        byte_count: 10,
        source_id: "repository:README.md",
      },
    ],
    scan_manifest: {
      schema_version: "1",
      repository: {
        source_url: "https://github.com/example/product",
        revision: REVISION,
        is_dirty: false,
      },
      files: [{ path: "README.md", file_type: "documentation" }],
    },
  };
}

function release(
  tagName: string,
  prerelease: boolean,
  publishedAt: string,
): AgentGitHubRelease {
  return {
    tag_name: tagName,
    prerelease,
    published_at: publishedAt,
    url: `https://github.com/example/product/releases/tag/${tagName}`,
    source_id: `github_release:${tagName}`,
    source_path: `github-releases/${tagName}.md`,
  };
}
