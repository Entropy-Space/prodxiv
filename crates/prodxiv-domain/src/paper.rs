use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const SUPPORTED_SCHEMA_VERSION: &str = "1";

pub const REQUIRED_SECTIONS: [&str; 8] = [
    "Summary",
    "Background",
    "Motivation",
    "Related Work",
    "Core Features",
    "Benchmarks",
    "Insights and Lessons",
    "Limitations",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PaperDocument {
    pub metadata: PaperMetadata,
    #[schemars(length(min = 1))]
    pub markdown: String,
}

impl PaperDocument {
    /// Parses a Markdown product paper with YAML front matter.
    ///
    /// # Errors
    ///
    /// Returns an error when front matter is absent, unterminated, or invalid.
    pub fn from_markdown(source: &str) -> Result<Self, PaperParseError> {
        let source = source.strip_prefix('\u{feff}').unwrap_or(source);
        let (front_matter_and_body, delimiter) = if let Some(rest) = source.strip_prefix("---\r\n")
        {
            (rest, "\r\n---\r\n")
        } else if let Some(rest) = source.strip_prefix("---\n") {
            (rest, "\n---\n")
        } else {
            return Err(PaperParseError::Missing);
        };
        let Some((front_matter, markdown)) = front_matter_and_body.split_once(delimiter) else {
            return Err(PaperParseError::Unterminated);
        };

        let metadata = serde_yaml::from_str(front_matter)
            .map_err(|error| PaperParseError::InvalidYaml(error.to_string()))?;

        Ok(Self {
            metadata,
            markdown: markdown.to_owned(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PaperMetadata {
    #[schemars(regex(pattern = r"^1$"))]
    pub schema_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(regex(pattern = r"^prodxiv:[0-9]{4}\.[0-9]{4}$"))]
    pub paper_id: Option<String>,
    #[schemars(length(min = 1))]
    pub title: String,
    #[schemars(length(min = 1))]
    pub summary: String,
    #[schemars(length(min = 1))]
    pub authors: Vec<Author>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(regex(pattern = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"))]
    pub published_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub version: Option<u32>,
    pub status: ProductStatus,
    #[schemars(length(min = 1), inner(regex(pattern = r"^[a-z0-9]+(?:_[a-z0-9]+)*$")))]
    pub topics: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1))]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(url)]
    pub product_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(url)]
    pub repository_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_bundle: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relationships: Vec<ProductRelationship>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Author {
    #[schemars(length(min = 1))]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub affiliation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(url)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProductStatus {
    Concept,
    PrivateBeta,
    PublicBeta,
    Launched,
    Discontinued,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProductRelationship {
    pub kind: RelationshipKind,
    #[schemars(regex(pattern = r"^prodxiv:[0-9]{4}\.[0-9]{4}$"))]
    pub paper_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RelationshipKind {
    InspiredBy,
    BuiltOn,
    AlternativeTo,
    Supersedes,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PaperParseError {
    #[error("paper must begin with YAML front matter delimited by `---`")]
    Missing,
    #[error("paper front matter is missing its closing `---` delimiter")]
    Unterminated,
    #[error("paper front matter is invalid: {0}")]
    InvalidYaml(String),
}
