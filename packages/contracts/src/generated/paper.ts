/* Generated from the canonical Rust contract. Do not edit manually. */

export type RelationshipKind =
  "inspired_by" | "built_on" | "alternative_to" | "supersedes";
export type PaperScopeKind = "product" | "feature" | "release";
export type ProductStatus =
  "concept" | "private_beta" | "public_beta" | "launched" | "discontinued";

export interface PaperDocument {
  markdown: string;
  metadata: PaperMetadata;
}
export interface PaperMetadata {
  /**
   * @minItems 1
   */
  authors: [Author, ...Author[]];
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
  status: ProductStatus;
  summary: string;
  title: string;
  /**
   * @minItems 1
   */
  topics: [string, ...string[]];
  version?: number | null;
}
export interface Author {
  affiliation?: string | null;
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
