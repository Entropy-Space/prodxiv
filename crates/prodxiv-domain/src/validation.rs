use std::collections::{HashMap, HashSet};

use pulldown_cmark::{Event, HeadingLevel, Parser, Tag, TagEnd};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use url::Url;
use utoipa::ToSchema;

use crate::{
    LEGACY_SCHEMA_VERSION, PaperDocument, PaperScopeKind, PaperStatus, ProductStatus,
    REQUIRED_SECTIONS, SUPPORTED_SCHEMA_VERSION, StatusDetermination, WriterKind,
    canonicalize_paper_id,
};

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
    if let Some(product_name) = &metadata.product_name {
        require_nonempty("metadata.product_name", product_name, &mut diagnostics);
    }
    validate_scope(paper, &mut diagnostics);

    if metadata.authors.is_empty() {
        error(
            &mut diagnostics,
            "authors.required",
            "metadata.authors",
            "at least one author is required",
        );
    }
    for (index, author) in metadata.authors.iter().enumerate() {
        if metadata.schema_version == SUPPORTED_SCHEMA_VERSION && author.kind.is_none() {
            error(
                &mut diagnostics,
                "authors.kind_required",
                &format!("metadata.authors[{index}].kind"),
                "schema version 2 authors must identify whether they are a person or organization",
            );
        }
        if let Some(id) = &author.id {
            require_nonempty(
                &format!("metadata.authors[{index}].id"),
                id,
                &mut diagnostics,
            );
            if !is_namespaced_id(id) {
                error(
                    &mut diagnostics,
                    "authors.invalid_id",
                    &format!("metadata.authors[{index}].id"),
                    "author IDs must use a namespaced value such as `github:owner`",
                );
            }
        }
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
    validate_writers_and_contact(paper, &mut diagnostics);
    validate_status(paper, &mut diagnostics);

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
    if metadata.revision == Some(0) {
        error(
            &mut diagnostics,
            "publication.invalid_revision",
            "metadata.version",
            "paper revision must be positive",
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
        if metadata.schema_version == LEGACY_SCHEMA_VERSION {
            error(
                &mut diagnostics,
                "submission.current_schema_required",
                "metadata.schema_version",
                "schema version 1 papers remain readable but new submissions must use schema version 2",
            );
        }
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
        if metadata.revision.is_some() {
            error(
                &mut diagnostics,
                "submission.version_forbidden",
                "metadata.version",
                "paper revisions are assigned by the publishing service",
            );
        }
        if metadata.product_name.is_none() {
            error(
                &mut diagnostics,
                "submission.product_name_required",
                "metadata.product_name",
                "submitted papers must identify their product",
            );
        }
        if metadata.scope.is_none() {
            error(
                &mut diagnostics,
                "submission.scope_required",
                "metadata.scope",
                "submitted papers must identify their scope",
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
        if metadata.revision.is_none() {
            error(
                &mut diagnostics,
                "publication.revision_required",
                "metadata.version",
                "published papers require a positive revision",
            );
        }
        if metadata.product_name.is_none() {
            error(
                &mut diagnostics,
                "publication.product_name_required",
                "metadata.product_name",
                "published papers must identify their product",
            );
        }
        if metadata.scope.is_none() {
            error(
                &mut diagnostics,
                "publication.scope_required",
                "metadata.scope",
                "published papers must identify their scope",
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

fn validate_scope(paper: &PaperDocument, diagnostics: &mut Vec<Diagnostic>) {
    let Some(scope) = &paper.metadata.scope else {
        return;
    };
    match scope.kind {
        PaperScopeKind::Product => {
            if scope.name.is_some() || scope.product_version.is_some() {
                error(
                    diagnostics,
                    "scope.product_has_detail",
                    "metadata.scope",
                    "product scope must not specify a feature name or product version",
                );
            }
        }
        PaperScopeKind::Feature => {
            if scope
                .name
                .as_ref()
                .is_none_or(|name| name.trim().is_empty())
            {
                error(
                    diagnostics,
                    "scope.feature_name_required",
                    "metadata.scope.name",
                    "feature scope requires a name",
                );
            }
        }
        PaperScopeKind::Release => {
            if scope
                .product_version
                .as_ref()
                .is_none_or(|version| version.trim().is_empty())
            {
                error(
                    diagnostics,
                    "scope.product_version_required",
                    "metadata.scope.product_version",
                    "release scope requires a product version",
                );
            }
        }
    }
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
    if schema_version != LEGACY_SCHEMA_VERSION && schema_version != SUPPORTED_SCHEMA_VERSION {
        error(
            diagnostics,
            "schema.unsupported_version",
            "schema_version",
            &format!(
                "unsupported schema version `{schema_version}`; expected `{LEGACY_SCHEMA_VERSION}` or `{SUPPORTED_SCHEMA_VERSION}`"
            ),
        );
    }
}

fn validate_writers_and_contact(paper: &PaperDocument, diagnostics: &mut Vec<Diagnostic>) {
    let metadata = &paper.metadata;
    if metadata.schema_version == LEGACY_SCHEMA_VERSION {
        if !metadata.writers.is_empty() {
            error(
                diagnostics,
                "schema.v1_writers_forbidden",
                "metadata.writers",
                "writers require paper schema version 2",
            );
        }
        if metadata.communication_email.is_some() {
            error(
                diagnostics,
                "schema.v1_communication_email_forbidden",
                "metadata.communication_email",
                "communication_email requires paper schema version 2",
            );
        }
        return;
    }
    if metadata.schema_version != SUPPORTED_SCHEMA_VERSION {
        return;
    }
    if metadata.writers.is_empty() {
        error(
            diagnostics,
            "writers.required",
            "metadata.writers",
            "schema version 2 papers require at least one writer",
        );
    }
    for (index, writer) in metadata.writers.iter().enumerate() {
        require_nonempty(
            &format!("metadata.writers[{index}].name"),
            &writer.name,
            diagnostics,
        );
        match writer.kind {
            WriterKind::Human if writer.model.is_some() => error(
                diagnostics,
                "writers.human_model_forbidden",
                &format!("metadata.writers[{index}].model"),
                "human writers must not specify a model",
            ),
            WriterKind::Agent
                if writer
                    .model
                    .as_ref()
                    .is_none_or(|model| model.trim().is_empty()) =>
            {
                error(
                    diagnostics,
                    "writers.agent_model_required",
                    &format!("metadata.writers[{index}].model"),
                    "agent writers must identify their model",
                );
            }
            WriterKind::Human | WriterKind::Agent => {}
        }
    }
    if let Some(email) = &metadata.communication_email {
        if !metadata
            .writers
            .iter()
            .any(|writer| writer.kind == WriterKind::Human)
        {
            error(
                diagnostics,
                "communication_email.human_writer_required",
                "metadata.communication_email",
                "communication_email is available only when a human writer is credited",
            );
        }
        if !is_email(email) {
            error(
                diagnostics,
                "communication_email.invalid",
                "metadata.communication_email",
                "communication_email must be a valid email address",
            );
        }
    }
}

fn validate_status(paper: &PaperDocument, diagnostics: &mut Vec<Diagnostic>) {
    let metadata = &paper.metadata;
    match (&metadata.schema_version[..], &metadata.status) {
        (LEGACY_SCHEMA_VERSION, PaperStatus::Legacy(ProductStatus::Unknown)) => error(
            diagnostics,
            "status.v1_unknown_forbidden",
            "metadata.status",
            "unknown status requires paper schema version 2",
        ),
        (LEGACY_SCHEMA_VERSION, PaperStatus::Legacy(_)) => {}
        (LEGACY_SCHEMA_VERSION, PaperStatus::Observed(_)) => error(
            diagnostics,
            "status.v1_scalar_required",
            "metadata.status",
            "schema version 1 status must be a scalar value",
        ),
        (SUPPORTED_SCHEMA_VERSION, PaperStatus::Legacy(_)) => error(
            diagnostics,
            "status.v2_observation_required",
            "metadata.status",
            "schema version 2 status must include its determination and confidence",
        ),
        (SUPPORTED_SCHEMA_VERSION, PaperStatus::Observed(status)) => {
            let is_unknown = status.value == ProductStatus::Unknown;
            let is_unverified = status.determination == StatusDetermination::Unverified;
            if is_unknown != is_unverified {
                error(
                    diagnostics,
                    "status.invalid_unverified_value",
                    "metadata.status",
                    "unknown status and unverified determination must be used together",
                );
            }
            if status.determination == StatusDetermination::Inferred {
                if status.evidence.is_empty() {
                    error(
                        diagnostics,
                        "status.inferred_evidence_required",
                        "metadata.status.evidence",
                        "inferred status requires at least one evidence reference",
                    );
                }
                if status.observed_at.is_none() {
                    error(
                        diagnostics,
                        "status.inferred_observed_at_required",
                        "metadata.status.observed_at",
                        "inferred status requires an observation timestamp",
                    );
                }
            }
            if let Some(observed_at) = &status.observed_at
                && !is_utc_timestamp(observed_at)
            {
                error(
                    diagnostics,
                    "status.invalid_observed_at",
                    "metadata.status.observed_at",
                    "status observation timestamps must use UTC RFC 3339 notation",
                );
            }
            let mut evidence_urls = HashSet::new();
            for (index, evidence) in status.evidence.iter().enumerate() {
                validate_http_url(
                    &format!("metadata.status.evidence[{index}].url"),
                    &evidence.url,
                    diagnostics,
                );
                if !evidence_urls.insert(&evidence.url) {
                    error(
                        diagnostics,
                        "status.duplicate_evidence",
                        &format!("metadata.status.evidence[{index}].url"),
                        "status evidence URLs must be unique",
                    );
                }
                if evidence
                    .tag
                    .as_ref()
                    .is_some_and(|tag| tag.trim().is_empty())
                {
                    error(
                        diagnostics,
                        "status.invalid_evidence_tag",
                        &format!("metadata.status.evidence[{index}].tag"),
                        "status evidence tags must not be empty",
                    );
                }
            }
        }
        _ => {}
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

fn is_namespaced_id(value: &str) -> bool {
    let Some((provider, identity)) = value.split_once(':') else {
        return false;
    };
    !provider.is_empty()
        && provider.bytes().enumerate().all(|(index, byte)| {
            if index == 0 {
                byte.is_ascii_lowercase()
            } else {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
            }
        })
        && !identity.is_empty()
        && identity == identity.trim()
        && !identity.chars().any(char::is_control)
}

fn is_email(value: &str) -> bool {
    if value != value.trim() || value.chars().any(char::is_whitespace) {
        return false;
    }
    let mut parts = value.split('@');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(local), Some(domain), None)
            if !local.is_empty()
                && !domain.is_empty()
                && !domain.starts_with('.')
                && !domain.ends_with('.')
    )
}

fn is_utc_timestamp(value: &str) -> bool {
    let Some(value) = value.strip_suffix('Z') else {
        return false;
    };
    let Some((date, time)) = value.split_once('T') else {
        return false;
    };
    if !is_iso_date(date) {
        return false;
    }
    let mut time_parts = time.split(':');
    let (Some(hour), Some(minute), Some(second), None) = (
        time_parts.next(),
        time_parts.next(),
        time_parts.next(),
        time_parts.next(),
    ) else {
        return false;
    };
    let (second, fraction) = second
        .split_once('.')
        .map_or((second, None), |(second, fraction)| {
            (second, Some(fraction))
        });
    if fraction.is_some_and(|fraction| {
        fraction.is_empty() || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    }) {
        return false;
    }
    matches!(
        (
            hour.parse::<u8>(),
            minute.parse::<u8>(),
            second.parse::<u8>()
        ),
        (Ok(0..=23), Ok(0..=59), Ok(0..=59))
    ) && hour.len() == 2
        && minute.len() == 2
        && second.len() == 2
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
