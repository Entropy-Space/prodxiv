use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use utoipa::ToSchema;

use crate::{
    PaperDocument, PaperMetadata, ValidationProfile, ValidationReport, canonicalize_paper_id,
    validate_paper,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicationIdentity {
    pub paper_id: String,
    pub version: u32,
    pub published_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PublishedPaper {
    pub schema_version: String,
    pub paper_id: String,
    pub version: u32,
    pub published_at: String,
    pub metadata: PaperMetadata,
    pub source_markdown: String,
}

#[derive(Debug, Error)]
pub enum PublicationPreparationError {
    #[error("published paper is invalid")]
    Invalid(ValidationReport),
    #[error("published metadata could not be serialized: {0}")]
    Serialize(#[from] serde_yaml::Error),
}

/// Applies server-owned publication metadata and creates canonical Markdown.
///
/// # Errors
///
/// Returns validation diagnostics when the finalized paper violates publication
/// invariants, or a serialization error when its metadata cannot be encoded.
pub fn prepare_publication(
    mut paper: PaperDocument,
    identity: PublicationIdentity,
) -> Result<PublishedPaper, PublicationPreparationError> {
    let paper_id =
        canonicalize_paper_id(&identity.paper_id).unwrap_or_else(|| identity.paper_id.clone());
    paper.metadata.paper_id = Some(paper_id.clone());
    paper.metadata.version = Some(identity.version);
    paper.metadata.published_at = Some(identity.published_at.clone());
    for relationship in &mut paper.metadata.relationships {
        if let Some(canonical) = canonicalize_paper_id(&relationship.paper_id) {
            relationship.paper_id = canonical;
        }
    }

    let report = validate_paper(&paper, ValidationProfile::Publication);
    if !report.valid {
        return Err(PublicationPreparationError::Invalid(report));
    }

    let metadata = serde_yaml::to_string(&paper.metadata)?;
    let source_markdown = format!("---\n{metadata}---\n{}", paper.markdown);

    Ok(PublishedPaper {
        schema_version: paper.metadata.schema_version.clone(),
        paper_id,
        version: identity.version,
        published_at: identity.published_at,
        metadata: paper.metadata,
        source_markdown,
    })
}
