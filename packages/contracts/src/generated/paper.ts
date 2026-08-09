/* Generated from the canonical Rust contract. Do not edit manually. */

export type AuthorKind = "person" | "organization";
export type RelationshipKind =
  "inspired_by" | "built_on" | "alternative_to" | "supersedes";
export type PaperScopeKind = "product" | "feature" | "release";
export type PaperStatus = ProductStatus | ProductStatusObservation;
export type ProductStatus =
  | "unknown"
  | "concept"
  | "private_beta"
  | "public_beta"
  | "launched"
  | "discontinued";
export type StatusConfidence = "high" | "medium" | "low";
export type StatusDetermination = "declared" | "inferred" | "unverified";
export type ProductStatusEvidenceKind = "github_release";
export type WriterKind = "human" | "agent";

export interface PaperDocument {
  markdown: string;
  metadata: PaperMetadata;
}
export interface PaperMetadata {
  /**
   * @minItems 1
   */
  authors: [Author, ...Author[]];
  communication_email?: string | null;
  license?: string | null;
  organization?: string | null;
  paper_id?: string | null;
  product_name?: string | null;
  product_url?: string | null;
  published_at?: string | null;
  relationships?: ProductRelationship[];
  repository_url?: string | null;
  schema_version: string;
  scope?: PaperScope | null;
  status: PaperStatus;
  summary: string;
  title: string;
  /**
   * @minItems 1
   */
  topics: [string, ...string[]];
  version?: number | null;
  writers?: PaperWriter[];
}
export interface Author {
  affiliation?: string | null;
  id?: string | null;
  kind?: AuthorKind | null;
  name: string;
  url?: string | null;
}
export interface ProductRelationship {
  kind: RelationshipKind;
  paper_id: string;
}
export interface PaperScope {
  kind: PaperScopeKind;
  name?: string | null;
  product_version?: string | null;
}
export interface ProductStatusObservation {
  confidence: StatusConfidence;
  determination: StatusDetermination;
  evidence?: ProductStatusEvidence[];
  observed_at?: string | null;
  value: ProductStatus;
}
export interface ProductStatusEvidence {
  kind: ProductStatusEvidenceKind;
  tag?: string | null;
  url: string;
}
export interface PaperWriter {
  kind: WriterKind;
  model?: string | null;
  name: string;
}
