/* Generated from the canonical Rust validation policy. Do not edit manually. */

export const validation_policy = {
  schema_version: "1",
  paper: {
    required_sections: [
      "Summary",
      "Background",
      "Motivation",
      "Related Work",
      "Core Features",
      "Benchmarks",
      "Insights and Lessons",
      "Limitations",
    ],
    publication_required_metadata: [
      "paper_id",
      "published_at",
      "version",
      "license",
    ],
  },
  evidence: { verified_claims_require_locations: true },
} as const;
export type ValidationPolicy = typeof validation_policy;
