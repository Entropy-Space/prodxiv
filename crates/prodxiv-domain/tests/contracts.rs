use std::{fs, path::Path};

use prodxiv_domain::{
    PaperDocument, PaperMetadata, PaperParseError, ProductStatus, PublicationIdentity,
    ValidationProfile, ValidationReport, prepare_publication, validate_paper, validation_policy,
};
use schemars::schema_for;

fn repository_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("domain crate must be inside the workspace crates directory")
}

fn diagnostic_codes(report: &prodxiv_domain::ValidationReport) -> Vec<&str> {
    report
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code.as_str())
        .collect()
}

#[test]
fn exemplary_paper_is_publication_valid() {
    let source = fs::read_to_string(repository_root().join("examples/papers/prodxiv.md"))
        .expect("exemplary paper should be readable");
    let paper = PaperDocument::from_markdown(&source).expect("exemplary paper should parse");
    let report = validate_paper(&paper, ValidationProfile::Publication);

    assert!(
        report.valid,
        "exemplary paper should be valid: {:#?}",
        report.diagnostics
    );
}

#[test]
fn draft_profile_allows_server_owned_publication_fields_to_be_absent() {
    let mut paper = PaperDocument {
        metadata: PaperMetadata {
            schema_version: "1".to_owned(),
            paper_id: None,
            title: "A draft".to_owned(),
            summary: "A complete paper that has not been submitted.".to_owned(),
            authors: vec![prodxiv_domain::Author {
                name: "Draft author".to_owned(),
                affiliation: None,
                url: None,
            }],
            organization: None,
            published_at: None,
            version: None,
            status: ProductStatus::Concept,
            topics: vec!["developer_tools".to_owned()],
            license: None,
            product_url: None,
            repository_url: None,
            relationships: Vec::new(),
        },
        markdown: prodxiv_domain::REQUIRED_SECTIONS
            .iter()
            .map(|section| format!("# {section}\n\nDraft content.\n"))
            .collect::<Vec<_>>()
            .join("\n"),
    };

    assert!(validate_paper(&paper, ValidationProfile::Draft).valid);
    assert!(!validate_paper(&paper, ValidationProfile::Publication).valid);

    paper.metadata.paper_id = Some("not-an-id".to_owned());
    paper.metadata.published_at = Some("2026-02-30".to_owned());
    paper.metadata.version = Some(0);
    paper.metadata.license = Some(String::new());
    let report = validate_paper(&paper, ValidationProfile::Draft);
    let codes = diagnostic_codes(&report);
    assert!(codes.contains(&"value.invalid_paper_id"));
    assert!(codes.contains(&"publication.invalid_date"));
    assert!(codes.contains(&"publication.invalid_version"));
    assert!(codes.contains(&"publication.invalid_license"));
}

#[test]
fn submission_requires_license_and_forbids_server_owned_metadata() {
    let source = fs::read_to_string(repository_root().join("examples/papers/prodxiv.md"))
        .expect("exemplary paper should be readable");
    let mut paper = PaperDocument::from_markdown(&source).expect("exemplary paper should parse");

    let report = validate_paper(&paper, ValidationProfile::Submission);
    let codes = diagnostic_codes(&report);
    assert!(codes.contains(&"submission.paper_id_forbidden"));
    assert!(codes.contains(&"submission.date_forbidden"));
    assert!(codes.contains(&"submission.version_forbidden"));

    paper.metadata.paper_id = None;
    paper.metadata.published_at = None;
    paper.metadata.version = None;
    assert!(validate_paper(&paper, ValidationProfile::Submission).valid);

    paper.metadata.license = None;
    assert!(
        diagnostic_codes(&validate_paper(&paper, ValidationProfile::Submission))
            .contains(&"submission.license_required")
    );
}

#[test]
fn publication_preparation_assigns_identity_and_preserves_body() {
    let source = fs::read_to_string(repository_root().join("examples/papers/prodxiv.md"))
        .expect("exemplary paper should be readable");
    let mut paper = PaperDocument::from_markdown(&source).expect("exemplary paper should parse");
    paper.metadata.paper_id = None;
    paper.metadata.published_at = None;
    paper.metadata.version = None;
    let original_body = paper.markdown.clone();

    let published = prepare_publication(
        paper,
        PublicationIdentity {
            paper_id: "prodxiv:2607.0042".to_owned(),
            version: 1,
            published_at: "2026-07-27".to_owned(),
        },
    )
    .expect("complete submission should publish");

    assert_eq!(published.paper_id, "prodxiv:2607.0042");
    assert_eq!(
        published.metadata.paper_id.as_deref(),
        Some(published.paper_id.as_str())
    );
    assert!(published.source_markdown.ends_with(&original_body));
    let reparsed =
        PaperDocument::from_markdown(&published.source_markdown).expect("source should reparse");
    assert_eq!(reparsed.metadata, published.metadata);
    assert_eq!(reparsed.markdown, original_body);
}

#[test]
fn missing_sections_produce_stable_diagnostics() {
    let source = include_str!("fixtures/missing-sections.md");
    let paper = PaperDocument::from_markdown(source).expect("fixture should parse");
    let report = validate_paper(&paper, ValidationProfile::Draft);

    assert!(!report.valid);
    assert_eq!(
        diagnostic_codes(&report)
            .into_iter()
            .filter(|code| *code == "sections.missing")
            .count(),
        7
    );
}

#[test]
fn malformed_front_matter_is_rejected() {
    assert_eq!(
        PaperDocument::from_markdown("# Summary\n\nNo front matter."),
        Err(PaperParseError::Missing)
    );
    assert!(matches!(
        PaperDocument::from_markdown(include_str!("fixtures/malformed-frontmatter.md")),
        Err(PaperParseError::InvalidYaml(_))
    ));
}

#[test]
fn parser_preserves_the_markdown_body() {
    let body = "# Summary\r\n\r\nPreserve me.  \r\n";
    let source = format!(
        "---\r\nschema_version: \"1\"\r\ntitle: Test\r\nsummary: Test\r\nauthors:\r\n  - name: Test\r\nstatus: concept\r\ntopics:\r\n  - test\r\n---\r\n{body}"
    );

    let paper = PaperDocument::from_markdown(&source).expect("paper should parse");
    assert_eq!(paper.markdown, body);
}

#[test]
fn checked_in_schemas_match_the_rust_contracts() {
    let schemas = [
        ("paper.schema.json", schema_for!(PaperDocument)),
        ("validation.schema.json", schema_for!(ValidationReport)),
    ];

    for (filename, schema) in schemas {
        let mut generated = serde_json::to_string_pretty(&schema).expect("schema should serialize");
        generated.push('\n');
        let checked_in = fs::read_to_string(repository_root().join("schemas").join(filename))
            .expect("checked-in schema should be readable");
        assert_eq!(
            checked_in, generated,
            "{filename} is stale; regenerate schemas"
        );
    }

    let mut generated_policy =
        serde_json::to_string_pretty(&validation_policy()).expect("policy should serialize");
    generated_policy.push('\n');
    let checked_in_policy =
        fs::read_to_string(repository_root().join("schemas/validation-policy.json"))
            .expect("checked-in policy should be readable");
    assert_eq!(
        checked_in_policy, generated_policy,
        "validation-policy.json is stale; regenerate schemas"
    );
}
