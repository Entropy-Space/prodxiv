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
      "Insights and Lessons",
      "Limitations",
      "References",
    ],
    publication_required_metadata: [
      "paper_id",
      "published_at",
      "version",
      "license",
      "product_name",
      "scope",
    ],
    submission_forbidden_metadata: ["paper_id", "published_at", "version"],
    submission_required_metadata: ["license", "product_name", "scope"],
  },
} as const;
export type ValidationPolicy = typeof validation_policy;
