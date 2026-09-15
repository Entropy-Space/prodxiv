use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{PaperDocument, PublishedPaper};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
pub enum PaperLanguage {
    #[serde(rename = "en")]
    En,
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "ja")]
    Ja,
    #[serde(rename = "de")]
    De,
    #[serde(rename = "fr")]
    Fr,
}

impl PaperLanguage {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::ZhCn => "zh-CN",
            Self::Ja => "ja",
            Self::De => "de",
            Self::Fr => "fr",
        }
    }
}

/// Language versions are sparse: no particular language is required.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PaperTranslation {
    pub language: PaperLanguage,
    pub source_sha256: String,
    pub title: String,
    pub summary: String,
    pub markdown: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TranslationJob {
    pub paper: PublishedPaper,
    pub language: PaperLanguage,
    pub source_sha256: String,
    pub attempts: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum TranslationResult {
    Completed { translation: PaperTranslation },
    Failed { source_sha256: String },
}

/// Check preservation of structure and non-prose assets, not semantic fidelity.
///
/// # Errors
/// Returns an explanation if a translation loses structure or changes assets.
pub fn validate_translation(
    source: &PaperDocument,
    translation: &PaperTranslation,
) -> Result<(), &'static str> {
    if translation.title.trim().is_empty()
        || translation.summary.trim().is_empty()
        || translation.markdown.trim().is_empty()
        || translation.model.trim().is_empty()
        || translation.title.len() > 16_000
        || translation.summary.len() > 64_000
        || translation.markdown.len() > 2 * 1024 * 1024
        || translation.model.len() > 256
    {
        return Err("translation fields are empty or exceed their size limits");
    }
    if translation.source_sha256.len() != 64
        || !translation
            .source_sha256
            .bytes()
            .all(|b| b.is_ascii_hexdigit())
    {
        return Err("translation source digest is invalid");
    }
    if protected_content(&source.markdown) != protected_content(&translation.markdown) {
        return Err("translation changed headings, links, code, or embedded HTML structure");
    }
    Ok(())
}

fn protected_content(markdown: &str) -> Vec<String> {
    let mut content = Vec::new();
    let mut in_code = false;
    for event in Parser::new(markdown) {
        match event {
            Event::Start(Tag::Heading { level, .. }) => content.push(format!("heading:{level}")),
            Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. }) => {
                content.push(format!("url:{dest_url}"));
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                content.push(format!("block:{kind:?}"));
                in_code = true;
            }
            Event::End(TagEnd::CodeBlock) => in_code = false,
            Event::Text(text) if in_code => content.push(format!("code:{text}")),
            Event::Code(text) => content.push(format!("inline:{text}")),
            Event::Html(html) | Event::InlineHtml(html) => content.push(format!("html:{html}")),
            _ => {}
        }
    }
    content
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PaperDocument, PaperTranslation) {
        let mut source =
            PaperDocument::from_markdown(include_str!("../../../examples/papers/prodxiv.md"))
                .unwrap();
        source.markdown = "# Summary\n\n[Docs](https://example.com) and `value`.\n\n```rust\nlet x = 1;\n```\n\n# Limitations\n\nUnknown.\n".into();
        let translation = PaperTranslation {
            language: PaperLanguage::Ja,
            source_sha256: "a".repeat(64),
            title: "概要".into(),
            summary: "説明".into(),
            markdown: source
                .markdown
                .replace("# Summary", "# 概要")
                .replace("# Limitations", "# 制限"),
            model: "test".into(),
        };
        (source, translation)
    }

    #[test]
    fn supports_translated_headings_without_english_variant() {
        let (source, translation) = fixture();
        assert!(validate_translation(&source, &translation).is_ok());
        assert_eq!(
            serde_json::to_value(vec![translation]).unwrap()[0]["language"],
            "ja"
        );
    }

    #[test]
    fn rejects_changed_links_code_and_missing_sections() {
        let (source, translation) = fixture();
        for (from, to) in [
            ("https://example.com", "https://other.com"),
            ("let x = 1", "let x = 2"),
            ("# 制限", "制限"),
            ("`value`", "`other`"),
        ] {
            let mut changed = translation.clone();
            changed.markdown = changed.markdown.replace(from, to);
            assert!(validate_translation(&source, &changed).is_err());
        }
    }
}
