use prodxiv_domain::{
    DraftOwnerKind, DraftReviewStatus, PaperDocument, PaperDraft, PaperDraftReview, PaperStatus,
    ProductStatusEvidence, ProductStatusEvidenceKind, PublicPaperDraft, PublicPaperDraftResponse,
    PublicPaperDraftSummary, ValidationProfile, public_draft_metadata, validate_paper,
};

fn draft(source_markdown: &str) -> PaperDraft {
    PaperDraft {
        paper_uuid: "00000000-0000-4000-8000-000000000001".to_owned(),
        revision: 3,
        owner_kind: DraftOwnerKind::Bot,
        source_markdown: source_markdown.to_owned(),
        review: PaperDraftReview::pending(),
        created_at: "2026-08-27T12:00:00.000000Z".to_owned(),
        updated_at: "2026-08-28T12:00:00.000000Z".to_owned(),
    }
}

#[test]
fn public_projection_never_serializes_private_review_fields() {
    let mut draft = draft(include_str!("../../../examples/papers/prodxiv.md"));
    // Even inconsistent historical review metadata must not cross the public
    // DTO boundary merely because the current state is pending.
    draft.review.reviewed_by = Some("private-reviewer".to_owned());
    draft.review.rejection_reason = Some("private-review-notes".to_owned());
    let public = PublicPaperDraft::from_pending(&draft).expect("pending draft is readable");
    let value = serde_json::to_value(&public).expect("public draft serializes");
    assert_eq!(value["review_status"], "pending_review");
    assert_eq!(value["revision"], 3);
    assert_eq!(value["owner_kind"], "bot");
    assert!(value.get("review").is_none());
    assert!(value.get("created_at").is_none());
    assert!(!value.to_string().contains("private-review"));
    let summary =
        serde_json::to_value(PublicPaperDraftSummary::from(&public)).expect("summary serializes");
    assert!(summary.get("source_markdown").is_none());
    assert!(summary.get("metadata").is_some());
}

#[test]
fn approved_and_rejected_drafts_have_no_public_projection() {
    for status in [DraftReviewStatus::Approved, DraftReviewStatus::Rejected] {
        let mut draft = draft("# Private draft\n");
        draft.review.status = status;
        assert!(PublicPaperDraft::from_pending(&draft).is_none());
    }
}

#[test]
fn malformed_or_invalid_metadata_is_omitted_without_losing_draft_content() {
    for source in ["# Unfinished draft\n", "---\ntitle: [broken\n---\nBody\n"] {
        let draft = PublicPaperDraft::from_pending(&draft(source)).expect("pending draft");
        assert!(draft.metadata.is_none());
        assert_eq!(draft.source_markdown, source);
        assert!(
            serde_json::to_value(draft)
                .expect("public draft serializes")
                .get("metadata")
                .is_none()
        );
    }
    let source = include_str!("../../../examples/papers/prodxiv.md");
    let mut paper = PaperDocument::from_markdown(source).expect("fixture parses");
    paper.metadata.repository_url = Some("javascript:alert(1)".to_owned());
    let invalid = format!(
        "---\n{}---\n# Unfinished draft\n",
        serde_yaml::to_string(&paper.metadata).expect("metadata serializes")
    );
    assert!(public_draft_metadata(&invalid).is_none());
    paper.metadata.repository_url = None;
    paper.metadata.schema_version = "future".to_owned();
    let unsupported = format!(
        "---\n{}---\n# Unfinished draft\n",
        serde_yaml::to_string(&paper.metadata).expect("metadata serializes")
    );
    assert!(public_draft_metadata(&unsupported).is_none());
    paper.metadata.schema_version = "2".to_owned();
    paper.metadata.topics = vec!["invalid__topic".to_owned()];
    let invalid_topic = format!(
        "---\n{}---\n# Unfinished draft\n",
        serde_yaml::to_string(&paper.metadata).expect("metadata serializes")
    );
    assert!(public_draft_metadata(&invalid_topic).is_none());
}

#[test]
fn valid_metadata_is_available_even_while_the_paper_body_is_incomplete() {
    let paper = PaperDocument::from_markdown(include_str!("../../../examples/papers/prodxiv.md"))
        .expect("fixture parses");
    let source = format!(
        "---\n{}---\n# Unfinished draft\n",
        serde_yaml::to_string(&paper.metadata).expect("metadata serializes")
    );
    assert_eq!(public_draft_metadata(&source), Some(paper.metadata));
}

#[test]
fn public_metadata_omits_credential_bearing_links_without_changing_publication_validity() {
    let fixture = PaperDocument::from_markdown(include_str!("../../../examples/papers/prodxiv.md"))
        .expect("fixture parses");
    for field in ["repository", "product", "author", "status"] {
        let mut paper = fixture.clone();
        let url = "https://example-user:example-password@example.com/product".to_owned();
        match field {
            "repository" => paper.metadata.repository_url = Some(url),
            "product" => paper.metadata.product_url = Some(url),
            "author" => paper.metadata.authors[0].url = Some(url),
            "status" => {
                let PaperStatus::Observed(status) = &mut paper.metadata.status else {
                    panic!("schema v2 fixture")
                };
                status.evidence.push(ProductStatusEvidence {
                    kind: ProductStatusEvidenceKind::GithubRelease,
                    url,
                    tag: None,
                });
            }
            _ => unreachable!(),
        }
        assert!(
            validate_paper(&paper, ValidationProfile::Publication).valid,
            "historical URL validity is unchanged"
        );
        let source = format!(
            "---\n{}---\n{}",
            serde_yaml::to_string(&paper.metadata).unwrap(),
            paper.markdown
        );
        assert!(
            public_draft_metadata(&source).is_none(),
            "unsafe {field} link must not enter public metadata"
        );
    }
}

#[test]
fn legacy_topic_slugs_remain_publication_valid_but_are_omitted_from_public_draft_metadata() {
    let mut paper =
        PaperDocument::from_markdown(include_str!("../../../examples/papers/prodxiv.md"))
            .expect("fixture parses");
    paper.metadata.topics = vec!["developer__tools".to_owned()];
    assert!(validate_paper(&paper, ValidationProfile::Publication).valid);
    let source = format!(
        "---\n{}---\n{}",
        serde_yaml::to_string(&paper.metadata).unwrap(),
        paper.markdown
    );
    assert!(public_draft_metadata(&source).is_none());
}

#[test]
fn publication_resolution_contains_only_canonical_identity() {
    let value = serde_json::to_value(PublicPaperDraftResponse::Published {
        paper_id: "prodxiv:2608.000001".to_owned(),
        revision: 2,
    })
    .expect("published resolution serializes");
    assert_eq!(
        value,
        serde_json::json!({
            "kind": "published",
            "paper_id": "prodxiv:2608.000001",
            "version": 2,
        })
    );
}
