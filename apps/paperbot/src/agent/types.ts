import type { ScanFileType, ScanManifest } from "../scan-manifest.ts";

export const AGENT_RUN_SCHEMA_VERSION = "1";

export type EvidenceKind = "repository" | "external" | "author" | "inference";
export type ReviewSeverity = "error" | "warning" | "question";
export type AgentRunState =
  | "initialized"
  | "source_ready"
  | "drafted"
  | "reviewed"
  | "needs_author_review"
  | "failed";

export interface AgentModelConfig {
  provider: "pi";
  model: string;
}

export interface AgentPaperMetadata {
  title: string;
  product_name: string;
  authors: string[];
  status:
    "concept" | "private_beta" | "public_beta" | "launched" | "discontinued";
  product_url?: string;
  repository_url?: string;
}

export interface AgentSourceFile {
  path: string;
  file_type: ScanFileType;
  content: string;
  content_sha256: string;
  byte_count: number;
  source_id: string;
}

export interface AgentSource {
  kind: "github" | "local";
  canonical_url?: string;
  local_path?: string;
  requested_ref?: string;
  resolved_revision: string;
  is_dirty: boolean;
  retrieved_at: string;
  homepage_url?: string;
  files: AgentSourceFile[];
  scan_manifest: ScanManifest;
}

export interface EvidenceItem {
  claim: string;
  evidence_kind: EvidenceKind;
  source_id: string;
  confidence: "high" | "medium" | "low";
  note?: string;
}

export interface ReviewIssue {
  severity: ReviewSeverity;
  section: string;
  message: string;
  source_ids: string[];
}

export interface DraftResponse {
  summary: string;
  topics: string[];
  markdown: string;
  evidence: EvidenceItem[];
  questions: string[];
}

export interface ReviewResponse {
  issues: ReviewIssue[];
  questions: string[];
}

export interface ModelCompletion {
  final_text: string;
  model: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface AuthoringRuntime {
  readonly provider: string;
  readonly model: string;
  complete(input: {
    prompt: string;
    run_path: string;
  }): Promise<ModelCompletion>;
}

export interface AgentRunRecord {
  schema_version: typeof AGENT_RUN_SCHEMA_VERSION;
  state: AgentRunState;
  started_at: string;
  updated_at: string;
  agent: AgentModelConfig;
  input: {
    repository: string;
    allow_remote_model: true;
    external_sources: string[];
    metadata: AgentPaperMetadata;
  };
  source?: AgentRunSourceRecord;
  artifacts: {
    source?: string;
    scan?: string;
    evidence?: string;
    draft?: string;
    questions?: string;
    review?: string;
    validation?: string;
  };
  draft_sha256?: string;
  error?: {
    message: string;
  };
}

export interface AgentRunSourceRecord {
  kind: AgentSource["kind"];
  canonical_url?: string;
  scan_source_url?: string;
  resolved_revision: string;
  is_dirty: boolean;
  retrieved_at: string;
}

export interface AgentRunResult {
  run_path: string;
  state: AgentRunState;
  validation: {
    valid: boolean;
    diagnostics: number;
  };
  source: {
    resolved_revision: string;
    selected_file_count: number;
  };
}
