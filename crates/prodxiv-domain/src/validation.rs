use std::collections::{HashMap, HashSet};

use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use url::Url;
use utoipa::ToSchema;

use crate::{PaperDocument, REQUIRED_SECTIONS, SUPPORTED_SCHEMA_VERSION, canonicalize_paper_id};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidationProfile {
    Draft,
    Submission,
    Publication,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ValidationReport {
    pub schema_version: String,
    pub valid: bool,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Diagnostic {
    pub severity: DiagnosticSeverity,
    pub code: String,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
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

    if profile == ValidationProfile::Submission {
        if metadata.paper_id.is_some() {
            error(
                &mut diagnostics,
                "submission.paper_id_forbidden",
                "metadata.paper_id",
                "paper identifiers are assigned by the publishing service",
            );
        }
        if metadata.published_at.is_some() {
            error(
                &mut diagnostics,
                "submission.date_forbidden",
                "metadata.published_at",
                "publication dates are assigned by the publishing service",
            );
        }
        if metadata.version.is_some() {
            error(
                &mut diagnostics,
                "submission.version_forbidden",
                "metadata.version",
                "paper versions are assigned by the publishing service",
            );
        }
        if metadata.license.is_none() {
            error(
                &mut diagnostics,
                "submission.license_required",
                "metadata.license",
                "submitted papers require a license",
            );
        }
    } else if profile == ValidationProfile::Publication {
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
    if canonicalize_paper_id(value).is_none() {
        error(
            diagnostics,
            "value.invalid_paper_id",
            path,
            "paper identifier must match `prodxiv:YYMM.XXXXXX` using Crockford Base32",
        );
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
