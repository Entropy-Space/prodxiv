use prodxiv_domain::{PublicPaperDraft, PublicPaperDraftSummary, encode_paper_id_suffix};

use super::*;

impl FakeStore {
    pub(super) fn public_draft_page(
        &self,
        limit: u32,
        cursor: Option<&PublicDraftCursor>,
    ) -> Result<PublicDraftPage, StoreError> {
        let drafts = self.drafts.lock().expect("fake drafts lock");
        let reviews = self.draft_reviews.lock().expect("fake reviews lock");
        let owners = self.draft_owners.lock().expect("fake owners lock");
        let mut entries = drafts
            .values()
            .filter_map(|revisions| {
                let revision = revisions.last()?;
                let snapshot = PaperDraft {
                    paper_uuid: revision.paper_uuid.clone(),
                    revision: revision.revision,
                    owner_kind: *owners.get(&revision.paper_uuid)?,
                    source_markdown: revision.source_markdown.clone(),
                    review: reviews.get(&revision.paper_uuid)?.clone(),
                    created_at: revisions[0].created_at.clone(),
                    updated_at: revision.created_at.clone(),
                };
                let draft = PublicPaperDraft::from_pending(&snapshot)?;
                // The fixture's edit timestamp is monotonically derived from its
                // revision number; all initial drafts deliberately share a timestamp.
                let cursor = PublicDraftCursor {
                    updated_at_micros: i64::from(revision.revision),
                    paper_uuid: draft.paper_uuid.clone(),
                };
                Some((PublicPaperDraftSummary::from(&draft), cursor))
            })
            .filter(|(_, item)| {
                cursor.is_none_or(|cursor| {
                    (item.updated_at_micros, &item.paper_uuid)
                        < (cursor.updated_at_micros, &cursor.paper_uuid)
                })
            })
            .collect::<Vec<_>>();
        entries.sort_by(|(_, left), (_, right)| {
            (right.updated_at_micros, &right.paper_uuid)
                .cmp(&(left.updated_at_micros, &left.paper_uuid))
        });
        let limit = usize::try_from(limit).expect("limit fits");
        let has_more = entries.len() > limit;
        entries.truncate(limit);
        let next_cursor = has_more
            .then(|| entries.last().map(|(_, cursor)| cursor.clone()))
            .flatten();
        Ok(PublicDraftPage {
            drafts: entries.into_iter().map(|(draft, _)| draft).collect(),
            next_cursor,
        })
    }

    pub(super) fn latest_publications(&self) -> Vec<(PublishedPaperSummary, PublicationCursor)> {
        let publications = self.publications.lock().expect("fake publications lock");
        let mut latest = HashMap::<&str, (usize, &PublishedPaper)>::new();
        for (index, paper) in publications.iter().enumerate() {
            if latest
                .get(paper.paper_id.as_str())
                .is_none_or(|(_, current)| paper.revision > current.revision)
            {
                latest.insert(&paper.paper_id, (index, paper));
            }
        }
        latest
            .into_values()
            .map(|(index, paper)| {
                (
                    PublishedPaperSummary::from(paper),
                    PublicationCursor {
                        created_at_micros: i64::try_from(index + 1).expect("index fits"),
                        paper_id: paper.paper_id.clone(),
                    },
                )
            })
            .collect()
    }

    pub(super) fn publication_page(
        &self,
        limit: u32,
        cursor: Option<&PublicationCursor>,
        filter: &PublicationFilter,
    ) -> Result<PublicationPage, StoreError> {
        let mut entries = self
            .latest_publications()
            .into_iter()
            .filter(|(paper, item)| {
                let metadata = &paper.metadata;
                let searchable = format!(
                    "{} {} {} {} {} {}",
                    paper.paper_id,
                    metadata.title,
                    metadata.summary,
                    metadata.product_name.as_deref().unwrap_or_default(),
                    metadata.repository_url.as_deref().unwrap_or_default(),
                    metadata
                        .authors
                        .iter()
                        .map(|author| author.name.as_str())
                        .collect::<Vec<_>>()
                        .join(" "),
                )
                .to_lowercase();
                filter
                    .q
                    .as_ref()
                    .is_none_or(|query| searchable.contains(&query.to_lowercase()))
                    && filter
                        .topic
                        .as_ref()
                        .is_none_or(|topic| metadata.topics.contains(topic))
                    && cursor.is_none_or(|cursor| {
                        (item.created_at_micros, &item.paper_id)
                            < (cursor.created_at_micros, &cursor.paper_id)
                    })
            })
            .collect::<Vec<_>>();
        entries.sort_by(|(_, left), (_, right)| {
            (right.created_at_micros, &right.paper_id)
                .cmp(&(left.created_at_micros, &left.paper_id))
        });
        let limit = usize::try_from(limit).expect("limit fits");
        let has_more = entries.len() > limit;
        entries.truncate(limit);
        let next_cursor = has_more
            .then(|| entries.last().map(|(_, cursor)| cursor.clone()))
            .flatten();
        Ok(PublicationPage {
            papers: entries.into_iter().map(|(paper, _)| paper).collect(),
            next_cursor,
        })
    }
}

fn public_app(store: Arc<FakeStore>) -> axum::Router {
    router(
        AppState::new(store, TOKEN, "api_test")
            .with_bot_principal(Some(BOT_TOKEN.to_owned()), "paperbot:daily".to_owned())
            .with_public_drafts(true),
    )
}

async fn get(application: &axum::Router, path: &str) -> axum::response::Response {
    application
        .clone()
        .oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn create(store: &FakeStore, source: &str, key: &str) -> PaperDraft {
    store
        .create_draft(source, "test_bot", DraftOwnerKind::Bot, key)
        .await
        .unwrap()
        .draft
}

#[tokio::test]
async fn public_drafts_require_explicit_opt_in_and_never_cache_errors() {
    let store = Arc::new(FakeStore::default());
    let draft = create(&store, "# Previously private content", "private-draft").await;
    let application = app(store);
    for path in [
        "/v1/public/drafts".to_owned(),
        format!("/v1/public/drafts/{}", draft.paper_uuid),
    ] {
        let response = get(&application, &path).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = json_body(response).await;
        assert_eq!(body["error"]["code"], "draft.public_reads_disabled");
        assert!(!body.to_string().contains("Previously private"));
    }
}

#[tokio::test]
async fn public_queue_contains_only_current_pending_safe_projections() {
    let store = Arc::new(FakeStore::default());
    let valid = create(&store, &submission_markdown(), "public-valid").await;
    let malformed = create(&store, "---\ntitle: [broken\n---\nBody", "public-malformed").await;
    let approved = create(&store, &submission_markdown(), "public-approved").await;
    let rejected = create(&store, &submission_markdown(), "public-rejected").await;
    for (draft, status) in [
        (&approved, DraftReviewStatus::Approved),
        (&rejected, DraftReviewStatus::Rejected),
    ] {
        let mut reviews = store.draft_reviews.lock().unwrap();
        let review = reviews.get_mut(&draft.paper_uuid).unwrap();
        review.status = status;
        review.reviewed_by = Some("private-review-actor".to_owned());
        review.rejection_reason = Some("private-rejection-reason".to_owned());
    }
    let application = public_app(store.clone());
    let response = get(&application, "/v1/public/drafts").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let body = json_body(response).await;
    let drafts = body["drafts"].as_array().unwrap();
    assert_eq!(drafts.len(), 2);
    let valid_summary = drafts
        .iter()
        .find(|item| item["paper_uuid"] == valid.paper_uuid)
        .unwrap();
    assert!(valid_summary["metadata"]["title"].is_string());
    let malformed_summary = drafts
        .iter()
        .find(|item| item["paper_uuid"] == malformed.paper_uuid)
        .unwrap();
    assert!(malformed_summary.get("metadata").is_none());
    for draft in drafts {
        assert_eq!(draft["review_status"], "pending_review");
        assert!(draft.get("source_markdown").is_none());
        assert!(draft.get("review").is_none());
    }
    assert!(!body.to_string().contains("private-review"));
    assert!(!body.to_string().contains("private-rejection"));

    let response = get(
        &application,
        &format!("/v1/public/drafts/{}", malformed.paper_uuid),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["kind"], "draft");
    assert_eq!(body["draft"]["source_markdown"], malformed.source_markdown);
    assert!(body["draft"].get("metadata").is_none());

    let missing = json_body(
        get(
            &application,
            "/v1/public/drafts/00000000-0000-4000-8000-999999999999",
        )
        .await,
    )
    .await;
    for paper_uuid in [&approved.paper_uuid, &rejected.paper_uuid] {
        let response = get(&application, &format!("/v1/public/drafts/{paper_uuid}")).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(json_body(response).await, missing);
    }

    // Existing management reads and author actions remain authenticated even
    // when an unrelated public reading surface is enabled.
    for path in [
        "/v1/drafts".to_owned(),
        format!("/v1/drafts/{}", valid.paper_uuid),
        format!("/v1/drafts/{}/revisions", valid.paper_uuid),
    ] {
        assert_eq!(
            get(&application, &path).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn public_pagination_is_stable_for_equal_timestamps_and_new_drafts() {
    let store = Arc::new(FakeStore::default());
    let first = create(&store, "# First", "pagination-first").await;
    let second = create(&store, "# Second", "pagination-second").await;
    let third = create(&store, "# Third", "pagination-third").await;
    let application = public_app(store.clone());
    let page = json_body(get(&application, "/v1/public/drafts?limit=1").await).await;
    assert_eq!(page["drafts"][0]["paper_uuid"], third.paper_uuid);
    let cursor = page["next_cursor"].as_str().unwrap();
    create(&store, "# Newer", "pagination-newer").await;
    let page = json_body(
        get(
            &application,
            &format!("/v1/public/drafts?limit=1&cursor={cursor}"),
        )
        .await,
    )
    .await;
    assert_eq!(page["drafts"][0]["paper_uuid"], second.paper_uuid);
    let cursor = page["next_cursor"].as_str().unwrap();
    let page = json_body(
        get(
            &application,
            &format!("/v1/public/drafts?limit=1&cursor={cursor}"),
        )
        .await,
    )
    .await;
    assert_eq!(page["drafts"][0]["paper_uuid"], first.paper_uuid);
    assert!(page.get("next_cursor").is_none());
    for path in [
        "/v1/public/drafts?limit=0",
        "/v1/public/drafts?limit=101",
        "/v1/public/drafts?limit=no",
        "/v1/public/drafts?cursor=broken",
    ] {
        let response = get(&application, path).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }
}

#[tokio::test]
async fn public_read_follows_current_revision_and_keeps_history_private() {
    let store = Arc::new(FakeStore::default());
    let draft = create(&store, "# Old source", "current-source").await;
    store
        .update_draft(
            &draft.paper_uuid,
            1,
            "# Current source",
            "author",
            DraftOwnerKind::Author,
        )
        .await
        .unwrap();
    let application = public_app(store);
    let body = json_body(
        get(
            &application,
            &format!("/v1/public/drafts/{}", draft.paper_uuid),
        )
        .await,
    )
    .await;
    assert_eq!(body["draft"]["revision"], 2);
    assert_eq!(body["draft"]["owner_kind"], "author");
    assert_eq!(body["draft"]["source_markdown"], "# Current source");
    assert_eq!(
        get(
            &application,
            &format!("/v1/public/drafts/{}/revisions/1", draft.paper_uuid)
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        get(&application, "/v1/public/drafts/not-a-uuid")
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn promoted_uuid_resolves_to_exact_publication_without_management_fields() {
    let store = Arc::new(FakeStore::default());
    let draft = create(&store, &submission_markdown(), "promoted-source").await;
    let published = store
        .approve_and_publish_draft(
            &draft.paper_uuid,
            1,
            "test_author",
            DraftOwnerKind::Author,
            "promotion-public",
            None,
        )
        .await
        .unwrap()
        .unwrap();
    let application = public_app(store);
    let response = get(
        &application,
        &format!("/v1/public/drafts/{}", draft.paper_uuid),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        json_body(response).await,
        json!({
            "kind": "published", "paper_id": published.paper.paper_id, "version": published.paper.revision,
        })
    );
    let queue = json_body(get(&application, "/v1/public/drafts").await).await;
    assert_eq!(queue["drafts"], json!([]));
}

fn publication(id: u32, revision: u32, title: &str, topic: &str) -> PublishedPaper {
    let mut paper = PaperDocument::from_markdown(&submission_markdown()).unwrap();
    paper.metadata.title = title.to_owned();
    paper.metadata.topics = vec![topic.to_owned()];
    prepare_publication(
        paper,
        PublicationIdentity {
            paper_id: format!("prodxiv:2608.{}", encode_paper_id_suffix(id).unwrap()),
            revision,
            published_at: "2026-08-28".to_owned(),
        },
        "prodxiv-product:2608.000001".to_owned(),
    )
    .unwrap()
}

#[tokio::test]
async fn archive_search_uses_latest_metadata_before_filtering_and_pagination() {
    let store = Arc::new(FakeStore::default());
    let mut papers = vec![
        publication(1, 1, "Superseded searchterm", "old_topic"),
        publication(1, 3, "Current title", "current_topic"),
        publication(2, 1, "Needle One", "matching_topic"),
        publication(3, 1, "Needle Two", "matching_topic"),
    ];
    // Both matches sit beyond 100 newer non-matching papers.
    papers.extend((4..108).map(|id| publication(id, 1, "Unrelated", "other_topic")));
    *store.publications.lock().unwrap() = papers;
    let application = public_app(store);
    let page = json_body(
        get(
            &application,
            "/v1/papers?q=NEEDLE&topic=matching_topic&limit=1",
        )
        .await,
    )
    .await;
    assert_eq!(page["papers"][0]["metadata"]["title"], "Needle Two");
    let cursor = page["next_cursor"].as_str().unwrap();
    let page = json_body(
        get(
            &application,
            &format!("/v1/papers?q=needle&topic=matching_topic&limit=1&cursor={cursor}"),
        )
        .await,
    )
    .await;
    assert_eq!(page["papers"][0]["metadata"]["title"], "Needle One");
    assert!(page.get("next_cursor").is_none());
    for path in [
        "/v1/papers?q=Superseded",
        "/v1/papers?topic=old_topic",
        "/v1/papers?q=needle&topic=current_topic",
        "/v1/papers?q=%25",
    ] {
        assert_eq!(
            json_body(get(&application, path).await).await["papers"],
            json!([])
        );
    }
    let topics = json_body(get(&application, "/v1/papers/topics").await).await;
    assert_eq!(
        topics["topics"],
        json!(["current_topic", "matching_topic", "other_topic"])
    );
    let revisions =
        json_body(get(&application, "/v1/papers/prodxiv:2608.000001/revisions").await).await;
    assert_eq!(
        revisions["revisions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|paper| paper["version"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [3, 1]
    );
    assert_eq!(
        revisions["revisions"][1]["metadata"]["title"],
        "Superseded searchterm"
    );
    assert!(revisions["revisions"][0].get("source_markdown").is_none());
}

#[tokio::test]
async fn rejects_invalid_archive_filters_and_missing_revision_lists() {
    let application = public_app(Arc::new(FakeStore::default()));
    for path in [
        format!("/v1/papers?q={}", "a".repeat(201)),
        "/v1/papers?q=bad%0Aquery".to_owned(),
        "/v1/papers?topic=bad-topic".to_owned(),
        "/v1/papers?topic=_leading".to_owned(),
        "/v1/papers/not-a-paper/revisions".to_owned(),
    ] {
        assert_eq!(
            get(&application, &path).await.status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        get(&application, "/v1/papers/prodxiv:2608.000001/revisions")
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn archive_preserves_and_filters_historically_accepted_topic_slugs() {
    let store = Arc::new(FakeStore::default());
    store.publications.lock().unwrap().push(publication(
        1,
        1,
        "Historical topic spelling",
        "developer__tools",
    ));
    let application = public_app(store);
    let response = get(&application, "/v1/papers?topic=developer__tools").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["papers"].as_array().unwrap().len(), 1);
    assert_eq!(
        body["papers"][0]["metadata"]["topics"],
        json!(["developer__tools"])
    );
    let topics = json_body(get(&application, "/v1/papers/topics").await).await;
    assert_eq!(topics["topics"], json!(["developer__tools"]));
}

#[test]
fn openapi_keeps_management_authorized_and_public_projection_separate() {
    let document = serde_json::to_value(prodxiv_api::openapi()).unwrap();
    assert!(document["paths"]["/v1/drafts"]["get"]["security"].is_array());
    assert!(
        document["paths"]["/v1/public/drafts"]["get"]
            .get("security")
            .is_none()
    );
    let properties = &document["components"]["schemas"]["PublicPaperDraft"]["properties"];
    for private in [
        "review",
        "reviewed_by",
        "rejection_reason",
        "created_at",
        "run_id",
        "source_snapshot",
    ] {
        assert!(properties.get(private).is_none(), "private field {private}");
    }
}
