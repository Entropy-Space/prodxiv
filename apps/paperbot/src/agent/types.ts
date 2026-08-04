import type { ScanFileType, ScanManifest } from "@prodxiv/paperbot-core";

export const AGENT_RUN_SCHEMA_VERSION = "2";

export type EvidenceKind = "repository" | "external" | "author" | "inference";
export type EvidenceStatus =
  "source_verified" | "qualified_inference" | "author_supplied";
export type AgentRunState =
  | "initialized"
  | "inputs_ready"
  | "evidence_ready"
  | "evidence_validated"
  | "authoring"
  | "awaiting_author"
  | "needs_author_review"
  | "failed";
export type AuthorPhase = "drafting" | "reviewing";
export type AgentSessionRole = "evidence" | "author";

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

export interface EvidenceCandidate {
  claim: string;
  evidence_kind: EvidenceKind;
  source_id: string;
  excerpt: string;
  confidence: "high" | "medium" | "low";
  note?: string;
}

export interface EvidenceLocator {
  path: string;
  line_start: number;
  line_end: number;
}

export interface EvidenceItem extends EvidenceCandidate {
  evidence_id: string;
  excerpt_sha256: string;
  locator: EvidenceLocator;
  status: EvidenceStatus;
}

export interface EvidenceConflict {
  description: string;
  source_ids: string[];
}

export interface EvidenceResponse {
  evidence: EvidenceCandidate[];
  contradictions: EvidenceConflict[];
  unknowns: string[];
  questions: string[];
}

export interface AuthorQuestion {
  question_id: string;
  question: string;
  reason: string;
  evidence_ids: string[];
}

export interface AskQuestionsResponse {
  action: "ask_questions";
  questions: Omit<AuthorQuestion, "question_id">[];
}

export interface DraftResponse {
  action: "submit_draft";
  summary: string;
  topics: string[];
  markdown: string;
  evidence_ids: string[];
  unresolved_questions: string[];
}

export type AuthoringResponse = AskQuestionsResponse | DraftResponse;

export interface ModelCompletion {
  final_text: string;
  model: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface ModelSessionSnapshot {
  session_id: string;
  session_path?: string;
}

export interface AuthoringSession {
  complete(input: { prompt: string }): Promise<ModelCompletion>;
  snapshot(): ModelSessionSnapshot;
  dispose(): void | Promise<void>;
}

export interface AuthoringRuntime {
  readonly provider: string;
  readonly model: string;
  startSession(input: {
    role: AgentSessionRole;
    run_path: string;
    session_id?: string;
    session_path?: string;
  }): Promise<AuthoringSession>;
}

export interface AgentSessionRecord {
  session_id: string;
  artifact?: string;
  artifact_sha256?: string;
  turn_count: number;
}

export interface AgentWorkflowRecord {
  author_phase: AuthorPhase;
  question_rounds: number;
  draft_revision: number;
  repair_attempts: number;
  current_draft?: string;
  pending_question_ids: string[];
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
  sessions: {
    evidence?: AgentSessionRecord;
    author?: AgentSessionRecord;
  };
  workflow: AgentWorkflowRecord;
  artifacts: {
    source?: string;
    scan?: string;
    evidence_candidates?: string;
    evidence_analysis?: string;
    evidence?: string;
    draft?: string;
    drafts?: string[];
    paper?: string;
    questions?: string;
    answers?: string[];
    validation?: string;
  };
  draft_sha256?: string;
  paper_sha256?: string;
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
  questions: {
    pending: number;
    round: number;
  };
  source: {
    resolved_revision: string;
    selected_file_count: number;
  };
}
