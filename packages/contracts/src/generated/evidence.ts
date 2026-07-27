/* Generated from the canonical Rust contract. Do not edit manually. */

export type ProvenanceState =
  "verified" | "inferred" | "author_provided" | "missing_evidence";
export type EvidenceSourceType =
  | "source_code"
  | "documentation"
  | "test"
  | "benchmark"
  | "configuration"
  | "manifest";

export interface EvidenceBundle {
  claims: ClaimEvidence[];
  repository: RepositorySnapshot;
  schema_version: string;
  sources: EvidenceSource[];
}
export interface ClaimEvidence {
  claim_id: string;
  locations?: EvidenceLocation[];
  notes?: string | null;
  provenance_state: ProvenanceState;
  statement: string;
}
export interface EvidenceLocation {
  line_end?: number | null;
  line_start?: number | null;
  source_id: string;
  symbol?: string | null;
}
export interface RepositorySnapshot {
  is_dirty: boolean;
  revision: string;
  source_url?: string | null;
}
export interface EvidenceSource {
  content_sha256: string;
  path: string;
  source_id: string;
  source_type: EvidenceSourceType;
}
