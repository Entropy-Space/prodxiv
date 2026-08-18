use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Number of mutable draft snapshots retained for one paper.
pub const DRAFT_REVISION_RETENTION: u32 = 5;

/// Maximum UTF-8 byte length of an optional draft rejection reason.
pub const MAX_DRAFT_REJECTION_REASON_BYTES: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DraftOwnerKind {
    Author,
    Bot,
}

impl DraftOwnerKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Author => "author",
            Self::Bot => "bot",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "author" => Some(Self::Author),
            "bot" => Some(Self::Bot),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DraftReviewStatus {
    PendingReview,
    Approved,
    Rejected,
}

impl DraftReviewStatus {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PendingReview => "pending_review",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending_review" => Some(Self::PendingReview),
            "approved" => Some(Self::Approved),
            "rejected" => Some(Self::Rejected),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PaperDraftReview {
    pub status: DraftReviewStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewed_revision: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewed_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejection_reason: Option<String>,
}

impl PaperDraftReview {
    #[must_use]
    pub const fn pending() -> Self {
        Self {
            status: DraftReviewStatus::PendingReview,
            reviewed_revision: None,
            reviewed_by: None,
            reviewed_at: None,
            rejection_reason: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PaperDraft {
    pub paper_uuid: String,
    pub revision: u32,
    pub owner_kind: DraftOwnerKind,
    pub source_markdown: String,
    pub review: PaperDraftReview,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PaperDraftSummary {
    pub paper_uuid: String,
    pub revision: u32,
    pub owner_kind: DraftOwnerKind,
    pub review: PaperDraftReview,
    pub created_at: String,
    pub updated_at: String,
}

impl From<&PaperDraft> for PaperDraftSummary {
    fn from(draft: &PaperDraft) -> Self {
        Self {
            paper_uuid: draft.paper_uuid.clone(),
            revision: draft.revision,
            owner_kind: draft.owner_kind,
            review: draft.review.clone(),
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
