//! Canonical product paper contracts.

mod draft;
mod paper;
mod policy;
mod public_draft;
mod publication;
mod translation;
mod validation;
pub use translation::{
    PaperLanguage, PaperTranslation, TranslationJob, TranslationResult, validate_translation,
};

pub use draft::{
    DRAFT_REVISION_RETENTION, DraftOwnerKind, DraftReviewStatus, MAX_DRAFT_REJECTION_REASON_BYTES,
    PaperDraft, PaperDraftReview, PaperDraftRevision, PaperDraftRevisionSummary, PaperDraftSummary,
};
pub use paper::{
    Author, AuthorKind, LEGACY_SCHEMA_VERSION, PAPER_ID_ALPHABET, PAPER_ID_SUFFIX_LENGTH,
    PRODUCT_ID_PREFIX, PaperDocument, PaperMetadata, PaperParseError, PaperScope, PaperScopeKind,
    PaperStatus, PaperWriter, ProductRelationship, ProductStatus, ProductStatusEvidence,
    ProductStatusEvidenceKind, ProductStatusObservation, REQUIRED_SECTIONS, RelationshipKind,
    SUPPORTED_SCHEMA_VERSION, StatusConfidence, StatusDetermination, WriterKind,
    canonicalize_paper_id, canonicalize_product_id, encode_paper_id_suffix,
    product_id_from_paper_id,
};
pub use policy::{
    PUBLICATION_REQUIRED_METADATA, PaperValidationPolicy, ValidationPolicy, validation_policy,
};
pub use public_draft::{
    PublicDraftReviewStatus, PublicPaperDraft, PublicPaperDraftResponse, PublicPaperDraftSummary,
    public_draft_metadata,
};
pub use publication::{
    PublicationIdentity, PublicationPreparationError, PublishedPaper, PublishedPaperSummary,
    prepare_publication,
};
pub use validation::{
    Diagnostic, DiagnosticSeverity, ValidationProfile, ValidationReport, validate_paper,
};
