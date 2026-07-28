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
    submission_forbidden_metadata: ["paper_id", "published_at", "version"],
    submission_required_metadata: ["license"],
  },
} as const;
export type ValidationPolicy = typeof validation_policy;
