use std::{fs, path::Path};

use prodxiv_domain::{
    EvidenceBundle, PaperDocument, PaperMetadata, PaperParseError, ProductStatus,
    ValidationProfile, validate_evidence_bundle, validate_paper,
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
            evidence_bundle: None,
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
        PaperDocument::from_markdown("---\ntitle: [\n---\n\n# Summary"),
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
fn invalid_evidence_reports_unknown_sources_and_line_ranges() {
    let bundle: EvidenceBundle =
        serde_json::from_str(include_str!("fixtures/invalid-evidence.json"))
            .expect("fixture should deserialize");
    let report = validate_evidence_bundle(&bundle);
    let codes = diagnostic_codes(&report);

    assert!(!report.valid);
    assert!(codes.contains(&"evidence.unknown_source"));
    assert!(codes.contains(&"evidence.invalid_line_range"));
}

#[test]
fn checked_in_schemas_match_the_rust_contracts() {
    let schemas = [
        ("paper.schema.json", schema_for!(PaperDocument)),
        ("evidence.schema.json", schema_for!(EvidenceBundle)),
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
}
