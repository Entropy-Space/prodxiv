use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use url::Url;
use utoipa::ToSchema;

use crate::{
    DiagnosticSeverity, DraftOwnerKind, DraftReviewStatus, PaperDocument, PaperDraft,
    PaperMetadata, PaperStatus, ValidationProfile, validation::validate_metadata,
};

/// The public read surface intentionally has no approved or rejected state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PublicDraftReviewStatus {
    PendingReview,
}

/// A pending draft's public reading metadata, without management or audit data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PublicPaperDraftSummary {
    pub paper_uuid: String,
    pub revision: u32,
    pub owner_kind: DraftOwnerKind,
    pub review_status: PublicDraftReviewStatus,
    pub updated_at: String,
    /// Absent when draft front matter cannot represent valid paper metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<PaperMetadata>,
}

/// Only the current pending revision is eligible for this public projection.
/// The Markdown itself is public draft content in this projection; private
/// review actors, rejection reasons, history, and run artifacts are not included.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PublicPaperDraft {
    pub paper_uuid: String,
    pub revision: u32,
    pub owner_kind: DraftOwnerKind,
    pub review_status: PublicDraftReviewStatus,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<PaperMetadata>,
    pub source_markdown: String,
}

impl PublicPaperDraft {
    /// Projects a single, consistent management snapshot, failing closed for
    /// every state other than pending review.
    #[must_use]
    pub fn from_pending(draft: &PaperDraft) -> Option<Self> {
        (draft.review.status == DraftReviewStatus::PendingReview).then(|| Self {
            paper_uuid: draft.paper_uuid.clone(),
            revision: draft.revision,
            owner_kind: draft.owner_kind,
            review_status: PublicDraftReviewStatus::PendingReview,
            updated_at: draft.updated_at.clone(),
            metadata: public_draft_metadata(&draft.source_markdown),
            source_markdown: draft.source_markdown.clone(),
        })
    }
}

impl From<&PublicPaperDraft> for PublicPaperDraftSummary {
    fn from(draft: &PublicPaperDraft) -> Self {
        Self {
            paper_uuid: draft.paper_uuid.clone(),
            revision: draft.revision,
            owner_kind: draft.owner_kind,
            review_status: draft.review_status,
            updated_at: draft.updated_at.clone(),
            metadata: draft.metadata.clone(),
        }
    }
}

/// Resolves an unpublished UUID to its current public draft or the exact
/// immutable revision to which it was promoted. No UUID enters published URLs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PublicPaperDraftResponse {
    Draft {
        draft: Box<PublicPaperDraft>,
    },
    Published {
        paper_id: String,
        #[serde(rename = "version")]
        revision: u32,
    },
}

/// Best-effort metadata parsing is not a declaration that the draft is ready
/// for publication. A missing or unfinished body does not hide valid metadata,
/// while malformed, unsupported, or invalid metadata is omitted entirely.
#[must_use]
pub fn public_draft_metadata(source_markdown: &str) -> Option<PaperMetadata> {
    let paper = PaperDocument::from_markdown(source_markdown).ok()?;
    let diagnostics = validate_metadata(&paper, ValidationProfile::Draft);
    (!diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
        // The generated metadata schema is stricter than historical topic
        // validation. Apply that restriction only to this optional projection;
        // never change whether an immutable published paper remains valid.
        && paper.metadata.topics.iter().all(|topic| !topic.contains("__"))
        && has_anonymous_links(&paper.metadata))
    .then_some(paper.metadata)
}

fn has_anonymous_links(metadata: &PaperMetadata) -> bool {
    let evidence = match &metadata.status {
        PaperStatus::Observed(status) => status.evidence.as_slice(),
        PaperStatus::Legacy(_) => &[],
    };
    // This is a stricter *public draft projection* boundary, not a change to
    // historic publication validity. Embedded credentials must never become a
    // reader's metadata link; the raw draft remains the original source.
    [
        metadata.product_url.as_deref(),
        metadata.repository_url.as_deref(),
    ]
    .into_iter()
    .flatten()
    .chain(
        metadata
            .authors
            .iter()
            .filter_map(|author| author.url.as_deref()),
    )
    .chain(evidence.iter().map(|item| item.url.as_str()))
    .all(|value| {
        Url::parse(value).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
        })
    })
}
