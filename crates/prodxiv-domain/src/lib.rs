//! Canonical product paper contracts.

mod paper;
mod policy;
mod publication;
mod validation;

pub use paper::{
    Author, PaperDocument, PaperMetadata, PaperParseError, ProductRelationship, ProductStatus,
    REQUIRED_SECTIONS, RelationshipKind, SUPPORTED_SCHEMA_VERSION,
};
pub use policy::{
    PUBLICATION_REQUIRED_METADATA, PaperValidationPolicy, ValidationPolicy, validation_policy,
};
pub use publication::{
    PublicationIdentity, PublicationPreparationError, PublishedPaper, prepare_publication,
};
pub use validation::{
    Diagnostic, DiagnosticSeverity, ValidationProfile, ValidationReport, validate_paper,
};
