//! Canonical product paper and evidence contracts.

mod evidence;
mod paper;
mod validation;

pub use evidence::{
    ClaimEvidence, EvidenceBundle, EvidenceLocation, EvidenceSource, EvidenceSourceType,
    ProvenanceState, RepositorySnapshot,
};
pub use paper::{
    Author, PaperDocument, PaperMetadata, PaperParseError, ProductRelationship, ProductStatus,
    REQUIRED_SECTIONS, RelationshipKind, SUPPORTED_SCHEMA_VERSION,
};
pub use validation::{
    Diagnostic, DiagnosticSeverity, ValidationProfile, ValidationReport, validate_evidence_bundle,
    validate_paper,
};
