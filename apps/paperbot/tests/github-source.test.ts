import { describe, expect, test } from "bun:test";

import {
  canonicalizeGitHubRepositoryUrl,
  classifyGitHubSourcePath,
  fetchGitHubReleases,
  fetchGitHubSource,
  GitHubSourceError,
  selectDefaultGitHubSourcePaths,
  type GitHubRepositorySnapshot,
} from "@prodxiv/paperbot-source";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const BLOB_SHA = "89abcdef0123456789abcdef0123456789abcdef";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function repositoryMetadata(overrides: Record<string, unknown> = {}): unknown {
  return {
    private: false,
    visibility: "public",
    default_branch: "main",
    homepage: "https://example.test/product",
    ...overrides,
  };
}

function tree(entries: unknown[], truncated = false): unknown {
  return { truncated, tree: entries };
}

function blob(path: string, size = 1, sha = BLOB_SHA): unknown {
  return {
    path,
    mode: "100644",
    type: "blob",
    sha,
    size,
  };
}

function gitBlobSha(content: string): string {
  return new Bun.CryptoHasher("sha1")
    .update(`blob ${Buffer.byteLength(content)}\u0000`)
    .update(content)
    .digest("hex");
}

function fetchMock(responses: Map<string, Response>): {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const response = responses.get(url);
      return response?.clone() ?? new Response("not found", { status: 404 });
    },
  };
}

function urls(): {
  metadata: string;
  commit: string;
  tree: string;
  readme: string;
  source: string;
  releases: string;
} {
  const api = "https://api.github.com/repos/example/product";
  const raw = `https://raw.githubusercontent.com/example/product/${REVISION}`;
  return {
    metadata: api,
    commit: `${api}/commits/main`,
    tree: `${api}/git/trees/${REVISION}?recursive=1`,
    readme: `${raw}/README.md`,
    source: `${raw}/src/index.ts`,
    releases: `${api}/releases?per_page=10&page=1`,
  };
}

describe("canonicalizeGitHubRepositoryUrl", () => {
  test("accepts only canonical anonymous GitHub repository URLs", () => {
    expect(
      canonicalizeGitHubRepositoryUrl("https://github.com/example/product.git"),
    ).toEqual({
      owner: "example",
      repository: "product",
      canonical_url: "https://github.com/example/product",
    });

    for (const value of [
      "http://github.com/example/product",
      "https://GITHUB.com/example/product",
      "https://github.com/example/product/",
      "https://github.com/example/product?ref=main",
      "https://github.com/example/product#readme",
      "https://token@github.com/example/product",
      "https://github.com/example/product/issues",
      "https://gitlab.com/example/product",
      "https://github.com/example/%2E%2E",
    ]) {
      expect(() => canonicalizeGitHubRepositoryUrl(value)).toThrow(
        GitHubSourceError,
      );
    }
  });
});

describe("fetchGitHubSource", () => {
  test("pins selected source files to an exact commit and never sends authorization", async () => {
    const endpoint = urls();
    const explicitCommit = endpoint.commit.replace("main", "release%2Fv1");
    const mock = fetchMock(
      new Map([
        [endpoint.metadata, jsonResponse(repositoryMetadata())],
        [explicitCommit, jsonResponse({ sha: REVISION })],
        [
          endpoint.tree,
          jsonResponse(
            tree([
              { path: "src", mode: "040000", type: "tree", sha: BLOB_SHA },
              blob("README.md", 6, gitBlobSha("hello\n")),
              blob(
                "src/index.ts",
                29,
                gitBlobSha("export const product = true;\n"),
              ),
            ]),
          ),
        ],
        [endpoint.readme, new Response("hello\n")],
        [endpoint.source, new Response("export const product = true;\n")],
      ]),
    );

    const result = await fetchGitHubSource({
      repository_url: "https://github.com/example/product.git",
      ref: "release/v1",
      selected_paths: ["src/index.ts", "README.md"],
      fetch: mock.fetch,
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });

    expect(result).toEqual({
      canonical_url: "https://github.com/example/product",
      requested_ref: "release/v1",
      resolved_ref: "release/v1",
      resolved_revision: REVISION,
      retrieved_at: "2026-08-01T00:00:00.000Z",
      homepage_url: "https://example.test/product",
      files: [
        {
          path: "README.md",
          file_type: "documentation",
          content: "hello\n",
          content_sha256:
            "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
          byte_count: 6,
        },
        {
          path: "src/index.ts",
          file_type: "source_code",
          content: "export const product = true;\n",
          content_sha256:
            "4dbd0bb246647d8000b587c898db5d4670a5041c872210f86abcf08248c27ab9",
          byte_count: 29,
        },
      ],
      selection: {
        selected_paths: ["README.md", "src/index.ts"],
        tree_file_count: 2,
        skipped_file_counts: {
          excluded: 0,
          unsupported: 0,
          oversized: 0,
          selection_limit: 0,
        },
      },
    });
    expect(mock.calls.map((call) => call.url)).toEqual([
      endpoint.metadata,
      explicitCommit,
      endpoint.tree,
      endpoint.readme,
      endpoint.source,
    ]);
    for (const call of mock.calls) {
      const headers = new Headers(call.init.headers);
      expect(call.init.method).toBe("GET");
      expect(call.init.redirect).toBe("error");
      expect(headers.get("authorization")).toBeNull();
    }
  });

  test("uses a small deterministic default selection instead of downloading a tree", async () => {
    const endpoint = urls();
    const entries = [
      blob("README.md", 6, gitBlobSha("hello\n")),
      blob("package.json", 2, gitBlobSha("{}")),
      blob(".env", 12),
    ];
    for (let index = 0; index < 20; index += 1) {
      entries.push(blob(`src/${index}.ts`, 1, gitBlobSha("x")));
    }
    const mock = fetchMock(
      new Map([
        [endpoint.metadata, jsonResponse(repositoryMetadata())],
        [endpoint.commit, jsonResponse({ sha: REVISION })],
        [endpoint.tree, jsonResponse(tree(entries))],
        [endpoint.readme, new Response("hello\n")],
        [
          `https://raw.githubusercontent.com/example/product/${REVISION}/src/0.ts`,
          new Response("x"),
        ],
      ]),
    );

    const result = await fetchGitHubSource({
      repository_url: "https://github.com/example/product",
      fetch: mock.fetch,
      limits: { max_selected_files: 2 },
    });

    expect(result.selection.selected_paths).toEqual(["README.md", "src/0.ts"]);
    expect(result.selection.skipped_file_counts.excluded).toBe(1);
    expect(result.selection.skipped_file_counts.selection_limit).toBe(20);
    expect(mock.calls).toHaveLength(6);
  });

  test("selects implementation before nested documentation can exhaust the cap", () => {
    const snapshot: GitHubRepositorySnapshot = {
      canonical_url: "https://github.com/example/product",
      owner: "example",
      repository: "product",
      resolved_ref: "main",
      resolved_revision: REVISION,
      files: [
        {
          path: "README.md",
          blob_sha: BLOB_SHA,
          byte_count: 1,
          file_type: "documentation",
        },
        {
          path: "CHANGELOG.md",
          blob_sha: BLOB_SHA,
          byte_count: 1,
          file_type: "documentation",
        },
        {
          path: "package.json",
          blob_sha: BLOB_SHA,
          byte_count: 1,
          file_type: "manifest",
        },
        {
          path: "src/index.ts",
          blob_sha: BLOB_SHA,
          byte_count: 1,
          file_type: "source_code",
        },
        ...Array.from({ length: 16 }, (_, index) => ({
          path: `nested-${index}/README.md`,
          blob_sha: BLOB_SHA,
          byte_count: 1,
          file_type: "documentation" as const,
        })),
      ],
    };

    expect(
      selectDefaultGitHubSourcePaths(snapshot, { max_selected_files: 4 }),
    ).toMatchObject({
      selected_paths: [
        "README.md",
        "src/index.ts",
        "package.json",
        "CHANGELOG.md",
      ],
      skipped_file_counts: { selection_limit: 16 },
    });
  });

  test("reserves source coverage across product-defining repository areas", () => {
    const snapshot: GitHubRepositorySnapshot = {
      canonical_url: "https://github.com/example/product",
      owner: "example",
      repository: "product",
      resolved_ref: "main",
      resolved_revision: REVISION,
      files: [
        ["README.md", "documentation"],
        ["docs/architecture.md", "documentation"],
        ["src/core/engine.zig", "source_code"],
        ["src/clients/go/client.go", "source_code"],
        ["src/vopr.zig", "source_code"],
        ["benches/throughput.zig", "benchmark"],
        ["package.json", "manifest"],
        ...Array.from({ length: 12 }, (_, index) => [
          `src/clients/zz/generated-${index}.ts`,
          "source_code",
        ]),
      ].map(([path, fileType]) => ({
        path: path as string,
        blob_sha: BLOB_SHA,
        byte_count: 1,
        file_type: fileType as
          "benchmark" | "documentation" | "manifest" | "source_code",
      })),
    };

    expect(
      selectDefaultGitHubSourcePaths(snapshot, { max_selected_files: 7 }),
    ).toMatchObject({
      selected_paths: [
        "README.md",
        "src/core/engine.zig",
        "docs/architecture.md",
        "src/clients/go/client.go",
        "src/vopr.zig",
        "benches/throughput.zig",
        "package.json",
      ],
      skipped_file_counts: { selection_limit: 12 },
    });
    expect(classifyGitHubSourcePath("src/core/engine.zig")).toBe("source_code");
  });

  test("selects representative core subsystems before alphabetic utilities", () => {
    const paths = [
      "README.md",
      "src/aof.zig",
      "src/counting_allocator.zig",
      "src/state_machine.zig",
      "src/vsr.zig",
      "src/lsm/forest.zig",
      "src/io.zig",
      "src/clients/client.zig",
    ];
    const snapshot: GitHubRepositorySnapshot = {
      canonical_url: "https://github.com/example/product",
      owner: "example",
      repository: "product",
      resolved_ref: "main",
      resolved_revision: REVISION,
      files: paths.map((path) => ({
        path,
        blob_sha: BLOB_SHA,
        byte_count: 1,
        file_type: classifyGitHubSourcePath(path),
      })),
    };

    expect(
      selectDefaultGitHubSourcePaths(snapshot, { max_selected_files: 6 })
        .selected_paths,
    ).toEqual([
      "README.md",
      "src/state_machine.zig",
      "src/vsr.zig",
      "src/lsm/forest.zig",
      "src/io.zig",
      "src/clients/client.zig",
    ]);
  });

  test("excludes repository agent instruction documents from default selection", () => {
    const snapshot: GitHubRepositorySnapshot = {
      canonical_url: "https://github.com/example/product",
      owner: "example",
      repository: "product",
      resolved_ref: "main",
      resolved_revision: REVISION,
      files: [
        {
          path: "README.md",
          blob_sha: BLOB_SHA,
          byte_count: 1,
          file_type: "documentation",
        },
        ...[
          "AGENTS.md",
          "CLAUDE.md",
          "README_AI.md",
          "RULES_zh.md",
          "skills/SKILL.md",
        ].map((path) => ({
          path,
          blob_sha: BLOB_SHA,
          byte_count: 1,
          file_type: "documentation" as const,
        })),
        {
          path: "src/index.ts",
          blob_sha: BLOB_SHA,
          byte_count: 1,
          file_type: "source_code",
        },
      ],
    };

    expect(selectDefaultGitHubSourcePaths(snapshot)).toMatchObject({
      selected_paths: ["README.md", "src/index.ts"],
      skipped_file_counts: { excluded: 5 },
    });
  });

  test("prioritizes safe repository files linked by the root README", async () => {
    const endpoint = urls();
    const rootReadme = [
      "# Product",
      "",
      "[Primary routing](skills/routing.md)",
      "[Changelog](CHANGELOG.md)",
      "",
    ].join("\n");
    const routing = "# Primary routing\n";
    const changelog = "# Changelog\n";
    const mock = fetchMock(
      new Map([
        [endpoint.metadata, jsonResponse(repositoryMetadata())],
        [endpoint.commit, jsonResponse({ sha: REVISION })],
        [
          endpoint.tree,
          jsonResponse(
            tree([
              blob(
                "README.md",
                Buffer.byteLength(rootReadme),
                gitBlobSha(rootReadme),
              ),
              blob(
                "skills/routing.md",
                Buffer.byteLength(routing),
                gitBlobSha(routing),
              ),
              blob(
                "CHANGELOG.md",
                Buffer.byteLength(changelog),
                gitBlobSha(changelog),
              ),
              ...Array.from({ length: 16 }, (_, index) =>
                blob(`nested-${index}/README.md`),
              ),
            ]),
          ),
        ],
        [endpoint.readme, new Response(rootReadme)],
        [
          `https://raw.githubusercontent.com/example/product/${REVISION}/skills/routing.md`,
          new Response(routing),
        ],
        [
          `https://raw.githubusercontent.com/example/product/${REVISION}/CHANGELOG.md`,
          new Response(changelog),
        ],
      ]),
    );

    const result = await fetchGitHubSource({
      repository_url: "https://github.com/example/product",
      fetch: mock.fetch,
      limits: { max_selected_files: 3 },
    });

    expect(result.selection.selected_paths).toEqual([
      "README.md",
      "skills/routing.md",
      "CHANGELOG.md",
    ]);
  });

  test("limits README preferences so product coverage is not starved", () => {
    const preferredPaths = Array.from(
      { length: 8 },
      (_, index) => `docs/guide-${index}.md`,
    );
    const snapshot: GitHubRepositorySnapshot = {
      canonical_url: "https://github.com/example/product",
      owner: "example",
      repository: "product",
      resolved_ref: "main",
      resolved_revision: REVISION,
      files: [
        "README.md",
        ...preferredPaths,
        "docs/architecture.md",
        "src/core/engine.ts",
        "src/clients/client.ts",
        "src/vopr.ts",
        "benchmarks/throughput.ts",
        "package.json",
      ].map((path) => ({
        path,
        blob_sha: BLOB_SHA,
        byte_count: 1,
        file_type: classifyGitHubSourcePath(path),
      })),
    };

    expect(
      selectDefaultGitHubSourcePaths(
        snapshot,
        { max_selected_files: 8 },
        preferredPaths,
      ).selected_paths,
    ).toEqual([
      "README.md",
      "docs/guide-0.md",
      "docs/guide-1.md",
      "src/core/engine.ts",
      "docs/architecture.md",
      "src/clients/client.ts",
      "src/vopr.ts",
      "benchmarks/throughput.ts",
    ]);
  });

  test("rejects raw content whose Git blob identity does not match the tree", async () => {
    const endpoint = urls();
    const mock = fetchMock(
      new Map([
        [endpoint.metadata, jsonResponse(repositoryMetadata())],
        [endpoint.commit, jsonResponse({ sha: REVISION })],
        [endpoint.tree, jsonResponse(tree([blob("README.md", 6)]))],
        [endpoint.readme, new Response("hello\n")],
      ]),
    );

    await expect(
      fetchGitHubSource({
        repository_url: "https://github.com/example/product",
        selected_paths: ["README.md"],
        fetch: mock.fetch,
      }),
    ).rejects.toMatchObject({ code: "invalid_github_response" });
  });

  test("drops a query or fragment-bearing homepage from repository metadata", async () => {
    const endpoint = urls();
    const mock = fetchMock(
      new Map([
        [
          endpoint.metadata,
          jsonResponse(
            repositoryMetadata({
              homepage: "https://example.test/product#access_token=secret",
            }),
          ),
        ],
        [endpoint.commit, jsonResponse({ sha: REVISION })],
        [
          endpoint.tree,
          jsonResponse(tree([blob("README.md", 6, gitBlobSha("hello\n"))])),
        ],
        [endpoint.readme, new Response("hello\n")],
      ]),
    );

    const result = await fetchGitHubSource({
      repository_url: "https://github.com/example/product",
      selected_paths: ["README.md"],
      fetch: mock.fetch,
    });

    expect(result.homepage_url).toBeUndefined();
  });

  test("rejects private repositories before resolving a ref", async () => {
    const endpoint = urls();
    const mock = fetchMock(
      new Map([
        [
          endpoint.metadata,
          jsonResponse(
            repositoryMetadata({ private: true, visibility: "private" }),
          ),
        ],
      ]),
    );

    await expect(
      fetchGitHubSource({
        repository_url: "https://github.com/example/product",
        selected_paths: ["README.md"],
        fetch: mock.fetch,
      }),
    ).rejects.toMatchObject({ code: "repository_not_public" });
    expect(mock.calls.map((call) => call.url)).toEqual([endpoint.metadata]);
  });

  test("rejects a truncated tree, symlinks, submodules, and path traversal", async () => {
    const endpoint = urls();
    const unsafeTrees = [
      {
        name: "truncated",
        payload: tree([blob("README.md")], true),
        code: "truncated_tree",
      },
      {
        name: "symlink",
        payload: tree([
          { path: "linked", mode: "120000", type: "blob", sha: BLOB_SHA },
        ]),
        code: "symlink_not_supported",
      },
      {
        name: "submodule",
        payload: tree([
          { path: "nested", mode: "160000", type: "commit", sha: BLOB_SHA },
        ]),
        code: "submodule_not_supported",
      },
      {
        name: "traversal",
        payload: tree([blob("src/../secret.ts")]),
        code: "unsafe_tree_path",
      },
    ];

    for (const fixture of unsafeTrees) {
      const mock = fetchMock(
        new Map([
          [endpoint.metadata, jsonResponse(repositoryMetadata())],
          [endpoint.commit, jsonResponse({ sha: REVISION })],
          [endpoint.tree, jsonResponse(fixture.payload)],
        ]),
      );
      await expect(
        fetchGitHubSource({
          repository_url: "https://github.com/example/product",
          selected_paths: ["README.md"],
          fetch: mock.fetch,
        }),
        fixture.name,
      ).rejects.toMatchObject({ code: fixture.code });
      expect(mock.calls).toHaveLength(3);
    }
  });

  test("enforces raw-content byte limits from Content-Length before reading", async () => {
    const endpoint = urls();
    const mock = fetchMock(
      new Map([
        [endpoint.metadata, jsonResponse(repositoryMetadata())],
        [endpoint.commit, jsonResponse({ sha: REVISION })],
        [endpoint.tree, jsonResponse(tree([blob("README.md")]))],
        [
          endpoint.readme,
          new Response("0123456789", { headers: { "content-length": "10" } }),
        ],
      ]),
    );

    await expect(
      fetchGitHubSource({
        repository_url: "https://github.com/example/product",
        selected_paths: ["README.md"],
        fetch: mock.fetch,
        limits: { max_file_bytes: 8, max_total_bytes: 8 },
      }),
    ).rejects.toMatchObject({ code: "content_limit_exceeded" });
    expect(mock.calls.map((call) => call.url)).toEqual([
      endpoint.metadata,
      endpoint.commit,
      endpoint.tree,
      endpoint.readme,
    ]);
  });

  test("rejects a response that exceeds the cap when metadata does not know its size", async () => {
    const endpoint = urls();
    const mock = fetchMock(
      new Map([
        [endpoint.metadata, jsonResponse(repositoryMetadata())],
        [endpoint.commit, jsonResponse({ sha: REVISION })],
        [endpoint.tree, jsonResponse(tree([blob("README.md")]))],
        [endpoint.readme, new Response("0123456789")],
      ]),
    );

    await expect(
      fetchGitHubSource({
        repository_url: "https://github.com/example/product",
        selected_paths: ["README.md"],
        fetch: mock.fetch,
        limits: { max_file_bytes: 8, max_total_bytes: 8 },
      }),
    ).rejects.toMatchObject({ code: "content_limit_exceeded" });
  });
});

describe("fetchGitHubReleases", () => {
  test("captures bounded public release notes for deterministic status evidence", async () => {
    const endpoint = urls();
    const prereleaseNotesSha256 = new Bun.CryptoHasher("sha256")
      .update("Public release candidate notes.")
      .digest("hex");
    const mock = fetchMock(
      new Map([
        [
          endpoint.releases,
          jsonResponse([
            {
              draft: true,
              prerelease: false,
              tag_name: "unpublished",
              name: null,
              body: null,
              published_at: null,
              html_url:
                "https://github.com/example/product/releases/tag/unpublished",
            },
            {
              draft: false,
              prerelease: true,
              tag_name: "v2.0.0-rc.1",
              name: "Version 2 release candidate",
              body: "Public release candidate notes.",
              published_at: "2026-08-04T12:00:00Z",
              html_url:
                "https://github.com/example/product/releases/tag/v2.0.0-rc.1",
            },
            {
              draft: false,
              prerelease: false,
              tag_name: "v1.0.0",
              name: "Version 1",
              body: "Stable release notes.",
              published_at: "2026-08-01T00:00:00Z",
              html_url:
                "https://github.com/example/product/releases/tag/v1.0.0",
            },
          ]),
        ],
      ]),
    );

    const result = await fetchGitHubReleases({
      repository_url: "https://github.com/example/product",
      fetch: mock.fetch,
      now: () => new Date("2026-08-05T00:00:00Z"),
    });

    expect(result).toMatchObject({
      canonical_url: "https://github.com/example/product",
      retrieved_at: "2026-08-05T00:00:00.000Z",
      releases: [
        {
          tag_name: "v2.0.0-rc.1",
          prerelease: true,
          notes: "Public release candidate notes.",
          notes_sha256: prereleaseNotesSha256,
        },
        {
          tag_name: "v1.0.0",
          prerelease: false,
          notes: "Stable release notes.",
        },
      ],
    });
    expect(mock.calls.map((call) => call.url)).toEqual([endpoint.releases]);
  });

  test("hashes the exact bounded release notes retained in the snapshot", async () => {
    const endpoint = urls();
    const notes = "😀".repeat(5_000);
    const mock = fetchMock(
      new Map([
        [
          endpoint.releases,
          jsonResponse([
            {
              draft: false,
              prerelease: false,
              tag_name: "v1.0.0",
              name: "Version 1",
              body: notes,
              published_at: "2026-08-01T00:00:00Z",
              html_url:
                "https://github.com/example/product/releases/tag/v1.0.0",
            },
          ]),
        ],
      ]),
    );

    const result = await fetchGitHubReleases({
      repository_url: "https://github.com/example/product",
      fetch: mock.fetch,
    });
    const release = result.releases[0];

    expect(Buffer.byteLength(release?.notes ?? "")).toBe(16 * 1024);
    expect(release?.notes_truncated).toBe(true);
    expect(release?.notes_sha256).toBe(
      new Bun.CryptoHasher("sha256").update(release?.notes ?? "").digest("hex"),
    );
  });

  test("rejects impossible release publication dates", async () => {
    const endpoint = urls();
    const mock = fetchMock(
      new Map([
        [
          endpoint.releases,
          jsonResponse([
            {
              draft: false,
              prerelease: false,
              tag_name: "v1.0.0",
              name: "Version 1",
              body: "Stable release notes.",
              published_at: "2026-02-31T00:00:00Z",
              html_url:
                "https://github.com/example/product/releases/tag/v1.0.0",
            },
          ]),
        ],
      ]),
    );

    await expect(
      fetchGitHubReleases({
        repository_url: "https://github.com/example/product",
        fetch: mock.fetch,
      }),
    ).rejects.toMatchObject({ code: "invalid_github_response" });
  });

  test("rejects unsafe control characters in retained release notes", async () => {
    const endpoint = urls();
    const mock = fetchMock(
      new Map([
        [
          endpoint.releases,
          jsonResponse([
            {
              draft: false,
              prerelease: false,
              tag_name: "v1.0.0",
              name: "Version 1",
              body: "Stable\u0001release notes.",
              published_at: "2026-08-01T00:00:00Z",
              html_url:
                "https://github.com/example/product/releases/tag/v1.0.0",
            },
          ]),
        ],
      ]),
    );

    await expect(
      fetchGitHubReleases({
        repository_url: "https://github.com/example/product",
        fetch: mock.fetch,
      }),
    ).rejects.toMatchObject({ code: "invalid_github_response" });
  });
});
