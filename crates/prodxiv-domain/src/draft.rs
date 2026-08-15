use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Number of mutable draft snapshots retained for one paper.
pub const DRAFT_REVISION_RETENTION: u32 = 5;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PaperDraft {
    pub paper_uuid: String,
    pub revision: u32,
    pub source_markdown: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PaperDraftSummary {
    pub paper_uuid: String,
    pub revision: u32,
    pub created_at: String,
    pub updated_at: String,
}

impl From<&PaperDraft> for PaperDraftSummary {
    fn from(draft: &PaperDraft) -> Self {
        Self {
            paper_uuid: draft.paper_uuid.clone(),
            revision: draft.revision,
            created_at: draft.created_at.clone(),
            updated_at: draft.updated_at.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PaperDraftRevision {
    pub paper_uuid: String,
    pub revision: u32,
    pub source_markdown: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PaperDraftRevisionSummary {
    pub paper_uuid: String,
    pub revision: u32,
    pub created_at: String,
}

impl From<&PaperDraftRevision> for PaperDraftRevisionSummary {
    fn from(revision: &PaperDraftRevision) -> Self {
        Self {
            paper_uuid: revision.paper_uuid.clone(),
            revision: revision.revision,
            created_at: revision.created_at.clone(),
        }
    }
}
