//! Canonical product paper contracts.

mod paper;
mod policy;
mod publication;
mod validation;

pub use paper::{
    Author, PAPER_ID_ALPHABET, PAPER_ID_SUFFIX_LENGTH, PRODUCT_ID_PREFIX, PaperDocument,
    PaperMetadata, PaperParseError, PaperScope, PaperScopeKind, ProductRelationship, ProductStatus,
    REQUIRED_SECTIONS, RelationshipKind, SUPPORTED_SCHEMA_VERSION, canonicalize_paper_id,
    canonicalize_product_id, encode_paper_id_suffix, product_id_from_paper_id,
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
