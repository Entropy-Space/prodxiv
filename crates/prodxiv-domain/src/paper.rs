use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use utoipa::ToSchema;

pub const LEGACY_SCHEMA_VERSION: &str = "1";
pub const SUPPORTED_SCHEMA_VERSION: &str = "2";
pub const PAPER_ID_ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
pub const PAPER_ID_SUFFIX_LENGTH: usize = 6;
pub const PRODUCT_ID_PREFIX: &str = "prodxiv-product:";

pub const REQUIRED_SECTIONS: [&str; 8] = [
    "Summary",
    "Background",
    "Motivation",
    "Related Work",
    "Core Features",
    "Insights and Lessons",
    "Limitations",
    "References",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PaperMetadata {
    #[schemars(regex(pattern = r"^(?:1|2)$"))]
    pub schema_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(regex(pattern = r"^prodxiv:[0-9]{4}\.[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{6}$"))]
    #[schema(pattern = r"^prodxiv:[0-9]{4}\.[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{6}$")]
    pub paper_id: Option<String>,
    #[schemars(length(min = 1))]
    pub title: String,
    #[schemars(length(min = 1))]
    pub summary: String,
    #[schemars(length(min = 1))]
    pub authors: Vec<Author>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub writers: Vec<PaperWriter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(email)]
    pub communication_email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(regex(pattern = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"))]
    pub published_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    #[serde(rename = "version")]
    pub revision: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1))]
    pub product_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<PaperScope>,
    pub status: PaperStatus,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relationships: Vec<ProductRelationship>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Author {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(regex(pattern = r"^[a-z][a-z0-9_-]*:[^\s:][^\s]*$"))]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<AuthorKind>,
    #[schemars(length(min = 1))]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub affiliation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(url)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AuthorKind {
    Person,
    Organization,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PaperWriter {
    pub kind: WriterKind,
    #[schemars(length(min = 1))]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1))]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1))]
    pub tool_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1))]
    pub generation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum WriterKind {
    Human,
    Agent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(untagged)]
pub enum PaperStatus {
    Legacy(ProductStatus),
    Observed(ProductStatusObservation),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProductStatus {
    Unknown,
    Concept,
    PrivateBeta,
    PublicBeta,
    Launched,
    Discontinued,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ProductStatusObservation {
    pub value: ProductStatus,
    pub determination: StatusDetermination,
    pub confidence: StatusConfidence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(regex(
        pattern = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$"
    ))]
    pub observed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<ProductStatusEvidence>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StatusDetermination {
    Declared,
    Inferred,
    Unverified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StatusConfidence {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ProductStatusEvidence {
    pub kind: ProductStatusEvidenceKind,
    #[schemars(url)]
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1))]
    pub tag: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProductStatusEvidenceKind {
    GithubRelease,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PaperScope {
    pub kind: PaperScopeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_version: Option<String>,
}

impl Default for PaperScope {
    fn default() -> Self {
        Self {
            kind: PaperScopeKind::Product,
            name: None,
            product_version: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PaperScopeKind {
    Product,
    Feature,
    Release,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ProductRelationship {
    pub kind: RelationshipKind,
    #[schemars(regex(pattern = r"^prodxiv:[0-9]{4}\.[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{6}$"))]
    #[schema(pattern = r"^prodxiv:[0-9]{4}\.[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{6}$")]
    pub paper_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
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

#[must_use]
pub fn canonicalize_paper_id(value: &str) -> Option<String> {
    let (date, suffix) = value.strip_prefix("prodxiv:")?.split_once('.')?;
    let suffix = suffix.to_ascii_uppercase();
    if date.len() != 4
        || !date.bytes().all(|byte| byte.is_ascii_digit())
        || suffix.len() != PAPER_ID_SUFFIX_LENGTH
        || !suffix
            .bytes()
            .all(|byte| PAPER_ID_ALPHABET.as_bytes().contains(&byte))
    {
        return None;
    }

    Some(format!("prodxiv:{date}.{suffix}"))
}

#[must_use]
pub fn product_id_from_paper_id(paper_id: &str) -> Option<String> {
    canonicalize_paper_id(paper_id).map(|paper_id| {
        format!(
            "{PRODUCT_ID_PREFIX}{}",
            paper_id.trim_start_matches("prodxiv:")
        )
    })
}

#[must_use]
pub fn canonicalize_product_id(value: &str) -> Option<String> {
    let paper_id = format!("prodxiv:{}", value.strip_prefix(PRODUCT_ID_PREFIX)?);
    product_id_from_paper_id(&paper_id)
}

#[must_use]
pub fn encode_paper_id_suffix(mut value: u32) -> Option<String> {
    let alphabet = PAPER_ID_ALPHABET.as_bytes();
    let radix = u32::try_from(alphabet.len()).expect("paper ID alphabet length fits in u32");
    if value >= radix.pow(PAPER_ID_SUFFIX_LENGTH as u32) {
        return None;
    }

    let mut encoded = [alphabet[0]; PAPER_ID_SUFFIX_LENGTH];
    for character in encoded.iter_mut().rev() {
        let index = usize::try_from(value % radix).expect("alphabet index fits in usize");
        *character = alphabet[index];
        value /= radix;
    }
    String::from_utf8(encoded.to_vec()).ok()
}
