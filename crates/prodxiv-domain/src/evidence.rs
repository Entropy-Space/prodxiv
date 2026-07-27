use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EvidenceBundle {
    #[schemars(regex(pattern = r"^1$"))]
    pub schema_version: String,
    pub repository: RepositorySnapshot,
    pub sources: Vec<EvidenceSource>,
    pub claims: Vec<ClaimEvidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RepositorySnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(url)]
    pub source_url: Option<String>,
    #[schemars(length(min = 1))]
    pub revision: String,
    pub is_dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EvidenceSource {
    #[schemars(regex(pattern = r"^[a-z0-9]+(?:_[a-z0-9]+)*$"))]
    pub source_id: String,
    #[schemars(length(min = 1))]
    pub path: String,
    pub source_type: EvidenceSourceType,
    #[schemars(regex(pattern = r"^[0-9a-f]{64}$"))]
    pub content_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceSourceType {
    SourceCode,
    Documentation,
    Test,
    Benchmark,
    Configuration,
    Manifest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ClaimEvidence {
    #[schemars(regex(pattern = r"^[a-z0-9]+(?:_[a-z0-9]+)*$"))]
    pub claim_id: String,
    #[schemars(length(min = 1))]
    pub statement: String,
    pub provenance_state: ProvenanceState,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub locations: Vec<EvidenceLocation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProvenanceState {
    Verified,
    Inferred,
    AuthorProvided,
    MissingEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EvidenceLocation {
    #[schemars(regex(pattern = r"^[a-z0-9]+(?:_[a-z0-9]+)*$"))]
    pub source_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub line_start: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub line_end: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
}
