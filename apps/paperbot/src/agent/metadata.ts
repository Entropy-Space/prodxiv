import { ExitCode, PaperbotError } from "@prodxiv/paperbot-core";
import { canonicalizeGitHubRepositoryUrl } from "@prodxiv/paperbot-source";

import { normalizeAgentMetadata, normalizeAnonymousHttpUrl } from "./input.ts";
import type {
  AgentPaperMetadata,
  AgentPaperRequestMetadata,
  AgentSource,
} from "./types.ts";

export function completeAgentMetadata(
  requested: AgentPaperRequestMetadata,
  source: AgentSource,
  model: string,
  timestamp: string,
): AgentPaperMetadata {
  const repositoryUrl = normalizeOptionalSourceUrl(source.canonical_url);
  const homepageUrl = normalizeOptionalSourceUrl(source.homepage_url);

  if (source.kind === "github") {
    if (repositoryUrl === undefined) {
      throw new PaperbotError(
        "acquired GitHub source did not provide a canonical repository URL",
        ExitCode.scan,
      );
    }
    if (requested.repository_url !== undefined) {
      let requestedRepositoryUrl: string;
      try {
        requestedRepositoryUrl = canonicalizeGitHubRepositoryUrl(
          requested.repository_url,
        ).canonical_url;
      } catch {
        throw new PaperbotError(
          "agent GitHub source repository_url must identify the acquired GitHub repository",
          ExitCode.usage,
        );
      }
      if (
        requestedRepositoryUrl.toLowerCase() !== repositoryUrl.toLowerCase()
      ) {
        throw new PaperbotError(
          "agent GitHub source repository_url must match the acquired GitHub repository",
          ExitCode.usage,
        );
      }
    }
  }

  return normalizeAgentMetadata({
    ...requested,
    authors: completeAuthors(requested, source),
    writers: [{ kind: "agent", name: "paperbot", model }],
    status: completeStatus(requested, source, timestamp),
    ...(requested.repository_url === undefined && repositoryUrl !== undefined
      ? { repository_url: repositoryUrl }
      : {}),
    ...(source.kind === "github" && repositoryUrl !== undefined
      ? { repository_url: repositoryUrl }
      : {}),
    ...(requested.product_url === undefined && homepageUrl !== undefined
      ? { product_url: homepageUrl }
      : {}),
  });
}

function completeAuthors(
  metadata: AgentPaperRequestMetadata,
  source: AgentSource,
): AgentPaperMetadata["authors"] {
  if (metadata.authors !== undefined) {
    return metadata.authors.map((name) => ({ kind: "person", name }));
  }
  const sourceUrl =
    source.canonical_url ?? source.scan_manifest.repository.source_url;
  if (sourceUrl !== undefined) {
    try {
      const repository = canonicalizeGitHubRepositoryUrl(sourceUrl);
      return [
        {
          id: `github:${repository.owner}`,
          kind: "organization",
          name: repository.owner,
          url: `https://github.com/${repository.owner}`,
        },
      ];
    } catch {
      // A non-GitHub source cannot provide the default GitHub owner identity.
    }
  }
  throw new PaperbotError(
    "agent source has no GitHub repository owner; provide --author explicitly",
    ExitCode.usage,
  );
}

function completeStatus(
  metadata: AgentPaperRequestMetadata,
  source: AgentSource,
  timestamp: string,
): AgentPaperMetadata["status"] {
  if (metadata.status !== undefined) {
    if (metadata.status === "unknown") {
      return {
        value: "unknown",
        determination: "unverified",
        confidence: "low",
      };
    }
    return {
      value: metadata.status,
      determination: "declared",
      confidence: "high",
      observed_at: timestamp,
    };
  }

  const releaseSnapshot = source.github_releases;
  if (releaseSnapshot === undefined) {
    return unverifiedStatus();
  }
  const stableRelease = releaseSnapshot.releases.find(
    (release) => !release.prerelease && !hasPrereleaseMarker(release),
  );
  if (stableRelease !== undefined) {
    return inferredStatus(
      "launched",
      "high",
      releaseSnapshot.retrieved_at,
      stableRelease,
    );
  }
  const prerelease = releaseSnapshot.releases.find(
    (release) => release.prerelease || hasPrereleaseMarker(release),
  );
  if (prerelease !== undefined) {
    return inferredStatus(
      "public_beta",
      "medium",
      releaseSnapshot.retrieved_at,
      prerelease,
    );
  }
  return unverifiedStatus();
}

function unverifiedStatus(): AgentPaperMetadata["status"] {
  return {
    value: "unknown",
    determination: "unverified",
    confidence: "low",
  };
}

function inferredStatus(
  value: "launched" | "public_beta",
  confidence: "high" | "medium",
  observedAt: string,
  release: NonNullable<AgentSource["github_releases"]>["releases"][number],
): AgentPaperMetadata["status"] {
  return {
    value,
    determination: "inferred",
    confidence,
    observed_at: observedAt,
    evidence: [
      {
        kind: "github_release",
        url: release.url,
        tag: release.tag_name,
      },
    ],
  };
}

function hasPrereleaseMarker(
  release: NonNullable<AgentSource["github_releases"]>["releases"][number],
): boolean {
  const label = `${release.tag_name} ${release.name ?? ""}`;
  return /(?:^|[.\-_\s])(?:alpha|beta|preview|pre|rc)(?:[.\-_\s]|\d|$)/i.test(
    label,
  );
}

function normalizeOptionalSourceUrl(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return normalizeAnonymousHttpUrl(value, "source URL");
  } catch {
    return undefined;
  }
}
