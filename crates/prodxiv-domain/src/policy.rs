use serde::Serialize;

use crate::{REQUIRED_SECTIONS, SUPPORTED_SCHEMA_VERSION};

pub const PUBLICATION_REQUIRED_METADATA: [&str; 4] =
    ["paper_id", "published_at", "version", "license"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ValidationPolicy {
    pub schema_version: String,
    pub paper: PaperValidationPolicy,
    pub evidence: EvidenceValidationPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PaperValidationPolicy {
    pub required_sections: Vec<String>,
    pub publication_required_metadata: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EvidenceValidationPolicy {
    pub verified_claims_require_locations: bool,
}

#[must_use]
pub fn validation_policy() -> ValidationPolicy {
    ValidationPolicy {
        schema_version: SUPPORTED_SCHEMA_VERSION.to_owned(),
        paper: PaperValidationPolicy {
            required_sections: REQUIRED_SECTIONS.map(str::to_owned).to_vec(),
            publication_required_metadata: PUBLICATION_REQUIRED_METADATA
                .map(str::to_owned)
                .to_vec(),
        },
        evidence: EvidenceValidationPolicy {
            verified_claims_require_locations: true,
        },
    }
}
