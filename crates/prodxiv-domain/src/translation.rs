use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
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

#[derive(Debug, PartialEq, Eq)]
enum ProtectedContent {
    ScopeStart(TagEnd),
    ScopeEnd(TagEnd),
    Url(String),
    CodeBlock(String),
    Code(String),
    Html(String),
    InlineCode(Vec<String>),
}

fn protected_content(markdown: &str) -> Vec<ProtectedContent> {
    let mut content = Vec::new();
    let mut inline_code = Vec::new();
    let mut parent_inline_code = Vec::new();
    let mut in_code = false;
    // Parse tables so inline code stays in its original cell, not merely in
    // the same table (which the CommonMark-only parser treats as a paragraph).
    for event in Parser::new_ext(markdown, Options::ENABLE_TABLES) {
        // Keep even blocks without code in the comparison. Otherwise a snippet
        // could move into an adjacent empty-code paragraph or tight-list item.
        match &event {
            Event::Start(tag) if is_block(tag.to_end()) => {
                flush_inline_code(&mut content, &mut inline_code);
                content.push(ProtectedContent::ScopeStart(tag.to_end()));
            }
            Event::End(tag) if is_block(*tag) => {
                flush_inline_code(&mut content, &mut inline_code);
                content.push(ProtectedContent::ScopeEnd(*tag));
            }
            Event::Start(tag @ (Tag::Link { .. } | Tag::Image { .. })) => {
                // Link labels and image alt text must keep their own snippets.
                // Surrounding prose may still reorder code around the link.
                parent_inline_code.push(std::mem::take(&mut inline_code));
                content.push(ProtectedContent::ScopeStart(tag.to_end()));
            }
            Event::End(tag @ (TagEnd::Link | TagEnd::Image)) => {
                flush_inline_code(&mut content, &mut inline_code);
                content.push(ProtectedContent::ScopeEnd(*tag));
                inline_code = parent_inline_code.pop().unwrap_or_default();
            }
            _ => {}
        }
        match event {
            Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. }) => {
                content.push(ProtectedContent::Url(dest_url.into_string()));
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                content.push(ProtectedContent::CodeBlock(format!("{kind:?}")));
                in_code = true;
            }
            Event::End(TagEnd::CodeBlock) => in_code = false,
            Event::Text(text) if in_code => {
                content.push(ProtectedContent::Code(text.into_string()));
            }
            Event::Code(text) => inline_code.push(text.into_string()),
            Event::InlineHtml(html) => {
                // Raw markup is opaque: do not move code into or out of an
                // HTML link or other embedded element while translating prose.
                flush_inline_code(&mut content, &mut inline_code);
                content.push(ProtectedContent::Html(html.into_string()));
            }
            Event::Html(html) => {
                content.push(ProtectedContent::Html(html.into_string()));
            }
            _ => {}
        }
    }
    flush_inline_code(&mut content, &mut inline_code);
    content
}

fn is_block(tag: TagEnd) -> bool {
    !matches!(
        tag,
        TagEnd::Emphasis
            | TagEnd::Strong
            | TagEnd::Strikethrough
            | TagEnd::Superscript
            | TagEnd::Subscript
            | TagEnd::Link
            | TagEnd::Image
    )
}

fn flush_inline_code(content: &mut Vec<ProtectedContent>, inline_code: &mut Vec<String>) {
    if !inline_code.is_empty() {
        // Grammar may reorder snippets within prose. Sorting preserves their
        // exact parsed text and duplicate counts without fixing sentence order.
        inline_code.sort_unstable();
        content.push(ProtectedContent::InlineCode(std::mem::take(inline_code)));
    }
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

    fn validate_bodies(source_body: &str, translated_body: &str) -> Result<(), &'static str> {
        let (mut source, mut translation) = fixture();
        source.markdown = source_body.into();
        translation.markdown = translated_body.into();
        validate_translation(&source, &translation)
    }

    #[test]
    fn accepts_inline_code_reordering_within_prose_blocks() {
        for (source, translation) in [
            (
                "Use `{{key}}` in `.docx`, `.xlsx`, and `.pptx` files.",
                "在 `.docx`、`.xlsx` 和 `.pptx` 文件中使用 `{{key}}`。",
            ),
            ("# Use `key` in `file`", "# `file` で `key` を使う"),
            ("- Use `key` in `file`", "- `file` で `key` を使う"),
            ("> Use `key` in `file`", "> `file` で `key` を使う"),
            (
                "Use `key`, then `key` in `file`.",
                "`file` で `key`、続いて `key` を使う。",
            ),
            (
                "Use **`key`** with [Docs](https://example.com) in `file`.",
                "`file` で [資料](https://example.com) と **`key`** を使う。",
            ),
            (
                "| Usage |\n| --- |\n| Use `key` in `file` |\n",
                "| 使用方法 |\n| --- |\n| `file` で `key` を使う |\n",
            ),
            (
                "Use [`key` in `file`](https://example.com).",
                "[`file` で `key`](https://example.com) を使う。",
            ),
            (
                "Use <span>`key` in `file`</span>.",
                "<span>`file` で `key`</span> を使う。",
            ),
        ] {
            assert!(
                validate_bodies(source, translation).is_ok(),
                "{translation}"
            );
        }
    }

    #[test]
    fn rejects_changed_inline_code_text_or_occurrence_counts() {
        let source = "Use `key` twice: `key` in `file`.";
        for translation in [
            "`file` で `other`、続いて `key` を使う。",
            "`file` で `key` を使う。",
            "`file` で `key`、`key`、`key` を使う。",
            "`file` で `key`、`key` と `extra` を使う。",
            "`file` で key、続いて `key` を使う。",
        ] {
            assert!(
                validate_bodies(source, translation).is_err(),
                "{translation}"
            );
        }
    }

    #[test]
    fn rejects_inline_code_moving_between_blocks() {
        for (source, translation) in [
            ("Use `key`.\n\nSave `file`.", "Use `file`.\n\nSave `key`."),
            ("Use `key`.\n\nSave it.", "Use it.\n\nSave `key`."),
            ("# Use `key`\n\nSave `file`.", "# Use `file`\n\nSave `key`."),
            ("- Use `key`\n- Save `file`", "- Use `file`\n- Save `key`"),
            ("- Use `key`\n- Save it", "- Use it\n- Save `key`"),
            (
                "- Use `key`\n  - Save `file`",
                "- Use `file`\n  - Save `key`",
            ),
            (
                "> Use `key`.\n\nSave `file`.",
                "> Use `file`.\n\nSave `key`.",
            ),
            (
                "| First | Second |\n| --- | --- |\n| `key` | `file` |\n",
                "| First | Second |\n| --- | --- |\n| `file` | `key` |\n",
            ),
            (
                "| Usage |\n| --- |\n| `key` |\n| `file` |\n",
                "| Usage |\n| --- |\n| `file` |\n| `key` |\n",
            ),
        ] {
            assert!(
                validate_bodies(source, translation).is_err(),
                "{translation}"
            );
        }
    }

    #[test]
    fn preserves_other_assets_when_inline_code_is_reordered() {
        let source = "# Usage\n\nUse `key` in `file` with [Docs](https://example.com) and <span>text</span>.\n\n```rust\nlet x = 1;\n```\n\n<svg><path d=\"M0 0\" /></svg>\n";
        let translation = source.replace("Use `key` in `file`", "`file` で `key` を使う");
        assert!(validate_bodies(source, &translation).is_ok());
        for (from, to) in [
            ("https://example.com", "https://other.com"),
            ("```rust", "```python"),
            ("let x = 1", "let x = 2"),
            ("<span>", "<span class=\"changed\">"),
            ("M0 0", "M1 1"),
            ("# Usage", "## Usage"),
        ] {
            assert!(validate_bodies(source, &translation.replace(from, to)).is_err());
        }
    }

    #[test]
    fn preserves_inline_code_context() {
        for (source, translation) in [
            (
                "[`GET`](https://example.com/get) and [`POST`](https://example.com/post)",
                "[`POST`](https://example.com/get) and [`GET`](https://example.com/post)",
            ),
            (
                "[`key`](https://example.com) in `file`",
                "[`file`](https://example.com) in `key`",
            ),
            (
                "[`key`](https://example.com)",
                "[Docs](https://example.com) for `key`",
            ),
            (
                "![`key`](https://example.com/image.png) in `file`",
                "![`file`](https://example.com/image.png) in `key`",
            ),
            (
                "[![`key`](https://example.com/image.png)](https://example.com) in `file`",
                "[![`file`](https://example.com/image.png)](https://example.com) in `key`",
            ),
            (
                "<a href=\"/get\">`GET`</a> and `POST`",
                "<a href=\"/get\">`POST`</a> and `GET`",
            ),
            ("<span>`key`</span>", "<span>text</span> and `key`"),
        ] {
            assert!(
                validate_bodies(source, translation).is_err(),
                "{translation}"
            );
        }
    }
}
