import type { ScanFileType, ScanManifest } from "@prodxiv/paperbot-core";

export const AGENT_RUN_SCHEMA_VERSION = "5";

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
export type PiSessionRole = AgentSessionRole | "trend_selection";
export type AgentRunMode = "interactive" | "auto";
export type AgentFeedbackMode = "sync" | "async" | "none";
export type AgentGitHubReleasePolicy = "best_effort" | "disabled";

export interface AgentModelConfig {
  provider: "pi";
  model: string;
}

export interface AgentProducerProvenance {
  name: "paperbot";
  version: string;
  git_revision: string;
  git_dirty: boolean;
  source_state_sha256: string;
  build_id: string;
  bun_version: string;
  dependency_lock_sha256: string;
  run_schema_version: "4" | typeof AGENT_RUN_SCHEMA_VERSION;
  prompt_set_version: string;
  prompt_set_sha256: string;
  built_at?: string;
}

export type AgentPaperStatusValue =
  | "unknown"
  | "concept"
  | "private_beta"
  | "public_beta"
  | "launched"
  | "discontinued";

export interface AgentPaperRequestMetadata {
  title: string;
  product_name: string;
  authors?: string[];
  status?: AgentPaperStatusValue;
  product_url?: string;
  repository_url?: string;
}

export interface AgentAuthor {
  id?: string;
  kind: "person" | "organization";
  name: string;
  url?: string;
}

export interface AgentWriter {
  kind: "agent";
  name: "paperbot";
  model: string;
  tool_version: string;
  generation_id: string;
}

export interface AgentProductStatusEvidence {
  kind: "github_release";
  url: string;
  tag: string;
}

export interface AgentProductStatus {
  value: AgentPaperStatusValue;
  determination: "declared" | "inferred" | "unverified";
  confidence: "high" | "medium" | "low";
  observed_at?: string;
  evidence?: AgentProductStatusEvidence[];
}

export interface AgentPaperMetadata {
  title: string;
  product_name: string;
  authors: AgentAuthor[];
  writers: AgentWriter[];
  status: AgentProductStatus;
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
  github_releases?: AgentGitHubReleaseSnapshot;
  github_release_status?: AgentGitHubReleaseStatus;
  files: AgentSourceFile[];
  scan_manifest: ScanManifest;
}

export type AgentGitHubReleaseStatus =
  | {
      state: "captured";
      release_count: number;
    }
  | {
      state: "disabled";
      reason_code: "disabled_by_policy";
      message: string;
    }
  | {
      state: "skipped";
      reason_code: string;
      message: string;
    };

export interface AgentGitHubRelease {
  tag_name: string;
  name?: string;
  prerelease: boolean;
  published_at: string;
  url: string;
  notes?: string;
  notes_sha256?: string;
  notes_truncated?: boolean;
  source_id: string;
  source_path: string;
}

export interface AgentGitHubReleaseSnapshot {
  retrieved_at: string;
  releases: AgentGitHubRelease[];
}

export interface EvidenceCandidate {
  claim: string;
  evidence_kind: EvidenceKind;
  source_id: string;
  locator: EvidenceCandidateLocator;
  confidence: "high" | "medium" | "low";
  note?: string;
}

export interface EvidenceCandidateLocator {
  line_start: number;
  line_end: number;
}

export interface EvidenceLocator extends EvidenceCandidateLocator {
  path: string;
}

export interface EvidenceItem extends EvidenceCandidate {
  evidence_id: string;
  excerpt: string;
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
  assumptions: DraftAssumption[];
  unresolved_questions: string[];
}

export interface DraftAssumption {
  assumption: string;
  reason: string;
  evidence_ids: string[];
}

export type AuthoringResponse = AskQuestionsResponse | DraftResponse;

export interface ModelCompletion {
  final_text: string;
  provider: string;
  model: string;
  response_model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface ModelSessionSnapshot {
  session_id: string;
  session_path: string;
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
  artifact: string;
  artifact_sha256: string;
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

export type AgentCheckpointReason =
  "awaiting_author" | "needs_author_review" | "failed" | "recovered";

export interface AgentCheckpointRecord {
  checkpoint_number: number;
  reason: AgentCheckpointReason;
  state: AgentRunState;
  created_at: string;
  archive: string;
  archive_sha256: string;
  archive_byte_count: number;
  manifest_sha256: string;
  checkpoint_basis_sha256: string;
}

export interface AgentObservedModel {
  provider: string;
  model: string;
  response_model?: string;
}

export interface AgentRolloutSummary {
  event_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  observed_models: AgentObservedModel[];
  artifact_sha256: string;
  last_event_sha256?: string;
}

export interface AgentRunRecord {
  schema_version: typeof AGENT_RUN_SCHEMA_VERSION;
  run_id: string;
  state: AgentRunState;
  started_at: string;
  updated_at: string;
  producer: AgentProducerProvenance;
  producer_history: AgentProducerProvenance[];
  agent: AgentModelConfig;
  input: {
    repository: string;
    allow_remote_model: true;
    mode: AgentRunMode;
    feedback: AgentFeedbackMode;
    external_sources: string[];
    metadata: AgentPaperRequestMetadata | AgentPaperMetadata;
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
    assumptions?: string;
    validation?: string;
    rollout: string;
  };
  rollout: AgentRolloutSummary;
  checkpoints: AgentCheckpointRecord[];
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
  run_id: string;
  run_path: string;
  mode: AgentRunMode;
  feedback: AgentFeedbackMode;
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
    github_release_status?: AgentGitHubReleaseStatus;
  };
  checkpoint: AgentCheckpointRecord;
}
