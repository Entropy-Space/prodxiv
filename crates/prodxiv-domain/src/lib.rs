//! Canonical product paper contracts.

mod paper;
mod policy;
mod publication;
mod validation;

pub use paper::{
    Author, PAPER_ID_ALPHABET, PAPER_ID_SUFFIX_LENGTH, PaperDocument, PaperMetadata,
    PaperParseError, ProductRelationship, ProductStatus, REQUIRED_SECTIONS, RelationshipKind,
    SUPPORTED_SCHEMA_VERSION, canonicalize_paper_id, encode_paper_id_suffix,
};
pub use policy::{
    PUBLICATION_REQUIRED_METADATA, PaperValidationPolicy, ValidationPolicy, validation_policy,
};
pub use publication::{
    PublicationIdentity, PublicationPreparationError, PublishedPaper, PublishedPaperSummary,
    prepare_publication,
};
pub use validation::{
    Diagnostic, DiagnosticSeverity, ValidationProfile, ValidationReport, validate_paper,
};
