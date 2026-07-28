use serde::Serialize;

use crate::{REQUIRED_SECTIONS, SUPPORTED_SCHEMA_VERSION};

pub const PUBLICATION_REQUIRED_METADATA: [&str; 4] =
    ["paper_id", "published_at", "version", "license"];
pub const SUBMISSION_FORBIDDEN_METADATA: [&str; 3] = ["paper_id", "published_at", "version"];
pub const SUBMISSION_REQUIRED_METADATA: [&str; 1] = ["license"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ValidationPolicy {
    pub schema_version: String,
    pub paper: PaperValidationPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PaperValidationPolicy {
    pub required_sections: Vec<String>,
    pub publication_required_metadata: Vec<String>,
    pub submission_forbidden_metadata: Vec<String>,
    pub submission_required_metadata: Vec<String>,
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
            submission_forbidden_metadata: SUBMISSION_FORBIDDEN_METADATA
                .map(str::to_owned)
                .to_vec(),
            submission_required_metadata: SUBMISSION_REQUIRED_METADATA.map(str::to_owned).to_vec(),
        },
    }
}
