use std::collections::{HashMap, HashSet};

use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::{
    EvidenceBundle, PaperDocument, ProvenanceState, REQUIRED_SECTIONS, SUPPORTED_SCHEMA_VERSION,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidationProfile {
    Draft,
    Publication,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ValidationReport {
    pub schema_version: String,
    pub valid: bool,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Diagnostic {
    pub severity: DiagnosticSeverity,
    pub code: String,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
}

pub fn validate_paper(paper: &PaperDocument, profile: ValidationProfile) -> ValidationReport {
    let mut diagnostics = Vec::new();
    let metadata = &paper.metadata;

    require_supported_schema(&metadata.schema_version, &mut diagnostics);
    require_nonempty("metadata.title", &metadata.title, &mut diagnostics);
    require_nonempty("metadata.summary", &metadata.summary, &mut diagnostics);

    if metadata.authors.is_empty() {
        error(
            &mut diagnostics,
            "authors.required",
            "metadata.authors",
            "at least one author is required",
        );
    }
    for (index, author) in metadata.authors.iter().enumerate() {
        require_nonempty(
            &format!("metadata.authors[{index}].name"),
            &author.name,
            &mut diagnostics,
        );
        if let Some(url) = &author.url {
            validate_http_url(
                &format!("metadata.authors[{index}].url"),
                url,
                &mut diagnostics,
            );
        }
    }

    if metadata.topics.is_empty() {
        error(
            &mut diagnostics,
            "topics.required",
            "metadata.topics",
            "at least one topic is required",
        );
    }
    let mut topics = HashSet::new();
    for (index, topic) in metadata.topics.iter().enumerate() {
        let path = format!("metadata.topics[{index}]");
        if !is_slug(topic) {
            error(
                &mut diagnostics,
                "topics.invalid",
                &path,
                "topics must use lowercase snake_case",
            );
        }
        if !topics.insert(topic) {
            error(
                &mut diagnostics,
                "topics.duplicate",
                &path,
                "topics must be unique",
            );
        }
    }

    for (path, value) in [
        ("metadata.product_url", metadata.product_url.as_deref()),
        (
            "metadata.repository_url",
            metadata.repository_url.as_deref(),
        ),
    ] {
        if let Some(value) = value {
            validate_http_url(path, value, &mut diagnostics);
        }
    }

    for (index, relationship) in metadata.relationships.iter().enumerate() {
        validate_paper_id(
            &format!("metadata.relationships[{index}].paper_id"),
            &relationship.paper_id,
            &mut diagnostics,
        );
    }
    if let Some(evidence_bundle) = &metadata.evidence_bundle {
        validate_relative_path(
            "metadata.evidence_bundle",
            evidence_bundle,
            "value.invalid_relative_path",
            "evidence bundle must be a repository-relative path",
            &mut diagnostics,
        );
    }

    if let Some(paper_id) = &metadata.paper_id {
        validate_paper_id("metadata.paper_id", paper_id, &mut diagnostics);
    }
    if metadata
        .published_at
        .as_ref()
        .is_some_and(|date| !is_iso_date(date))
    {
        error(
            &mut diagnostics,
            "publication.invalid_date",
            "metadata.published_at",
            "publication date must use YYYY-MM-DD",
        );
    }
    if metadata.version == Some(0) {
        error(
            &mut diagnostics,
            "publication.invalid_version",
            "metadata.version",
            "paper version must be positive",
        );
    }
    if metadata
        .license
        .as_ref()
        .is_some_and(|value| value.trim().is_empty())
    {
        error(
            &mut diagnostics,
            "publication.invalid_license",
            "metadata.license",
            "license must not be empty",
        );
    }

    if profile == ValidationProfile::Publication {
        if metadata.paper_id.is_none() {
            error(
                &mut diagnostics,
                "publication.paper_id_required",
                "metadata.paper_id",
                "published papers require an archive identifier",
            );
        }
        if metadata.published_at.is_none() {
            error(
                &mut diagnostics,
                "publication.date_required",
                "metadata.published_at",
                "published papers require a publication date",
            );
        }
        if metadata.version.is_none() {
            error(
                &mut diagnostics,
                "publication.version_required",
                "metadata.version",
                "published papers require a positive version",
            );
        }
        if metadata.license.is_none() {
            error(
                &mut diagnostics,
                "publication.license_required",
                "metadata.license",
                "published papers require a license",
            );
        }
    }

    validate_sections(&paper.markdown, &mut diagnostics);
    report(diagnostics)
}

pub fn validate_evidence_bundle(bundle: &EvidenceBundle) -> ValidationReport {
    let mut diagnostics = Vec::new();
    require_supported_schema(&bundle.schema_version, &mut diagnostics);
    require_nonempty(
        "repository.revision",
        &bundle.repository.revision,
        &mut diagnostics,
    );

    if let Some(source_url) = &bundle.repository.source_url {
        validate_http_url("repository.source_url", source_url, &mut diagnostics);
    }

    let mut source_ids = HashSet::new();
    for (index, source) in bundle.sources.iter().enumerate() {
        let base = format!("sources[{index}]");
        require_identifier(
            &format!("{base}.source_id"),
            &source.source_id,
            &mut diagnostics,
        );
        if !source_ids.insert(source.source_id.as_str()) {
            error(
                &mut diagnostics,
                "evidence.duplicate_source_id",
                &format!("{base}.source_id"),
                "source identifiers must be unique",
            );
        }
        validate_relative_path(
            &format!("{base}.path"),
            &source.path,
            "evidence.invalid_path",
            "evidence paths must be non-empty, repository-relative paths",
            &mut diagnostics,
        );
        if !is_sha256(&source.content_sha256) {
            error(
                &mut diagnostics,
                "evidence.invalid_sha256",
                &format!("{base}.content_sha256"),
                "content_sha256 must contain 64 lowercase hexadecimal characters",
            );
        }
    }

    let mut claim_ids = HashSet::new();
    for (index, claim) in bundle.claims.iter().enumerate() {
        let base = format!("claims[{index}]");
        require_identifier(
            &format!("{base}.claim_id"),
            &claim.claim_id,
            &mut diagnostics,
        );
        if !claim_ids.insert(claim.claim_id.as_str()) {
            error(
                &mut diagnostics,
                "evidence.duplicate_claim_id",
                &format!("{base}.claim_id"),
                "claim identifiers must be unique",
            );
        }
        require_nonempty(
            &format!("{base}.statement"),
            &claim.statement,
            &mut diagnostics,
        );
        if claim.provenance_state == ProvenanceState::Verified && claim.locations.is_empty() {
            error(
                &mut diagnostics,
                "evidence.verified_requires_location",
                &format!("{base}.locations"),
                "verified claims require at least one evidence location",
            );
        }
        for (location_index, location) in claim.locations.iter().enumerate() {
            let location_path = format!("{base}.locations[{location_index}]");
            if !source_ids.contains(location.source_id.as_str()) {
                error(
                    &mut diagnostics,
                    "evidence.unknown_source",
                    &format!("{location_path}.source_id"),
                    "evidence location references an unknown source",
                );
            }
            if location.line_start.is_none() && location.line_end.is_some() {
                error(
                    &mut diagnostics,
                    "evidence.line_start_required",
                    &format!("{location_path}.line_start"),
                    "line_start is required when line_end is present",
                );
            }
            if location.line_start == Some(0) || location.line_end == Some(0) {
                error(
                    &mut diagnostics,
                    "evidence.invalid_line_number",
                    &location_path,
                    "line numbers must be positive",
                );
            }
            if let (Some(start), Some(end)) = (location.line_start, location.line_end)
                && end < start
            {
                error(
                    &mut diagnostics,
                    "evidence.invalid_line_range",
                    &location_path,
                    "line_end must be greater than or equal to line_start",
                );
            }
        }
    }

    report(diagnostics)
}

fn validate_sections(markdown: &str, diagnostics: &mut Vec<Diagnostic>) {
    let mut headings = Vec::new();
    let mut current_heading = None;
    for event in Parser::new(markdown) {
        match event {
            Event::Start(Tag::Heading {
                level: HeadingLevel::H1,
                ..
            }) => current_heading = Some(String::new()),
            Event::Text(text) | Event::Code(text) if current_heading.is_some() => {
                current_heading
                    .as_mut()
                    .expect("heading exists")
                    .push_str(&text);
            }
            Event::End(TagEnd::Heading(HeadingLevel::H1)) => {
                if let Some(heading) = current_heading.take() {
                    headings.push(heading.trim().to_owned());
                }
            }
            _ => {}
        }
    }

    let counts = headings.iter().fold(HashMap::new(), |mut counts, heading| {
        *counts.entry(heading.as_str()).or_insert(0_u32) += 1;
        counts
    });
    let mut last_position = None;
    for section in REQUIRED_SECTIONS {
        match headings.iter().position(|heading| heading == section) {
            None => error(
                diagnostics,
                "sections.missing",
                "markdown",
                &format!("required level-one section `{section}` is missing"),
            ),
            Some(position) => {
                if counts.get(section).copied().unwrap_or_default() > 1 {
                    error(
                        diagnostics,
                        "sections.duplicate",
                        "markdown",
                        &format!("required level-one section `{section}` appears more than once"),
                    );
                }
                if last_position.is_some_and(|previous| position < previous) {
                    error(
                        diagnostics,
                        "sections.out_of_order",
                        "markdown",
                        &format!("required level-one section `{section}` is out of order"),
                    );
                }
                last_position = Some(position);
            }
        }
    }
}

fn require_supported_schema(schema_version: &str, diagnostics: &mut Vec<Diagnostic>) {
    if schema_version != SUPPORTED_SCHEMA_VERSION {
        error(
            diagnostics,
            "schema.unsupported_version",
            "schema_version",
            &format!(
                "unsupported schema version `{schema_version}`; expected `{SUPPORTED_SCHEMA_VERSION}`"
            ),
        );
    }
}

fn require_nonempty(path: &str, value: &str, diagnostics: &mut Vec<Diagnostic>) {
    if value.trim().is_empty() {
        error(
            diagnostics,
            "value.required",
            path,
            "value must not be empty",
        );
    }
}

fn require_identifier(path: &str, value: &str, diagnostics: &mut Vec<Diagnostic>) {
    if !is_slug(value) {
        error(
            diagnostics,
            "value.invalid_identifier",
            path,
            "identifier must use lowercase snake_case",
        );
    }
}

fn validate_http_url(path: &str, value: &str, diagnostics: &mut Vec<Diagnostic>) {
    match Url::parse(value) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => {}
        _ => error(
            diagnostics,
            "value.invalid_url",
            path,
            "URL must be an absolute HTTP or HTTPS URL",
        ),
    }
}

fn validate_paper_id(path: &str, value: &str, diagnostics: &mut Vec<Diagnostic>) {
    let valid = value
        .strip_prefix("prodxiv:")
        .and_then(|suffix| suffix.split_once('.'))
        .is_some_and(|(date, sequence)| {
            date.len() == 4
                && sequence.len() == 4
                && date.bytes().all(|byte| byte.is_ascii_digit())
                && sequence.bytes().all(|byte| byte.is_ascii_digit())
        });
    if !valid {
        error(
            diagnostics,
            "value.invalid_paper_id",
            path,
            "paper identifier must match `prodxiv:YYMM.NNNN`",
        );
    }
}

fn validate_relative_path(
    path: &str,
    value: &str,
    code: &str,
    message: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let bytes = value.as_bytes();
    let has_windows_prefix =
        bytes.get(1) == Some(&b':') && matches!(bytes.get(2), Some(b'/' | b'\\'));
    let is_absolute = value.starts_with('/') || has_windows_prefix;
    let has_parent_component = value
        .replace('\\', "/")
        .split('/')
        .any(|component| component == "..");
    if value.is_empty() || is_absolute || has_parent_component {
        error(diagnostics, code, path, message);
    }
}

fn is_slug(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('_')
        && !value.ends_with('_')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_iso_date(value: &str) -> bool {
    let parts = value
        .split('-')
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>();
    let Ok(parts) = parts else {
        return false;
    };
    if parts.len() != 3 || value.len() != 10 {
        return false;
    }
    let (year, month, day) = (parts[0], parts[1], parts[2]);
    let leap_year =
        year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap_year => 29,
        2 => 28,
        _ => return false,
    };
    (1..=max_day).contains(&day)
}

fn report(diagnostics: Vec<Diagnostic>) -> ValidationReport {
    ValidationReport {
        schema_version: SUPPORTED_SCHEMA_VERSION.to_owned(),
        valid: diagnostics
            .iter()
            .all(|diagnostic| diagnostic.severity != DiagnosticSeverity::Error),
        diagnostics,
    }
}

fn error(diagnostics: &mut Vec<Diagnostic>, code: &str, path: &str, message: &str) {
    diagnostics.push(Diagnostic {
        severity: DiagnosticSeverity::Error,
        code: code.to_owned(),
        path: path.to_owned(),
        message: message.to_owned(),
    });
}
