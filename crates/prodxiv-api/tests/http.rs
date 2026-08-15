use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use prodxiv_api::{AppState, PublicationStore, StoreError, router};
use prodxiv_domain::{
    DRAFT_REVISION_RETENTION, PaperDocument, PaperDraft, PaperDraftRevision,
    PaperDraftRevisionSummary, PaperDraftSummary, PaperStatus, ProductStatus, PublicationIdentity,
    PublishedPaper, PublishedPaperSummary, prepare_publication,
};
use prodxiv_storage::{
    DraftUpdateOutcome, GitHubTrendingEntry, GitHubTrendingLanguageScope,
    GitHubTrendingLanguageSelector, GitHubTrendingSnapshot, GitHubTrendingView,
    NewGitHubTrendingSnapshot, PublicationCursor, PublicationPage, PublishOutcome,
    TrendingImportOutcome,
};
use serde_json::{Value, json};
use tower::ServiceExt;

const TOKEN: &str = "test_token_with_at_least_32_characters";
const INGEST_TOKEN: &str = "trending_ingest_token_with_32_characters";

#[derive(Default)]
struct FakeStore {
    drafts: Mutex<HashMap<String, Vec<PaperDraftRevision>>>,
    publications: Mutex<Vec<PublishedPaper>>,
    requests: Mutex<HashMap<String, (String, PublishedPaper)>>,
    trending_requests: Mutex<HashMap<String, String>>,
    trending_actors: Mutex<Vec<String>>,
    github_trending: Mutex<Vec<GitHubTrendingSnapshot>>,
}

#[async_trait]
impl PublicationStore for FakeStore {
    async fn create_draft(
        &self,
        source_markdown: &str,
        _actor: &str,
    ) -> Result<PaperDraft, StoreError> {
        let mut drafts = self.drafts.lock().expect("fake drafts should lock");
        let paper_uuid = format!(
            "00000000-0000-4000-8000-{:012x}",
            drafts.len().saturating_add(1)
        );
        let created_at = "2026-08-15T00:00:00.000000Z".to_owned();
        let revision = PaperDraftRevision {
            paper_uuid: paper_uuid.clone(),
            revision: 1,
            source_markdown: source_markdown.to_owned(),
            created_at: created_at.clone(),
        };
        drafts.insert(paper_uuid.clone(), vec![revision]);
        Ok(PaperDraft {
            paper_uuid,
            revision: 1,
            source_markdown: source_markdown.to_owned(),
            created_at: created_at.clone(),
            updated_at: created_at,
        })
    }

    async fn list_drafts(&self, limit: u32) -> Result<Vec<PaperDraftSummary>, StoreError> {
        let drafts = self.drafts.lock().expect("fake drafts should lock");
        Ok(drafts
            .values()
            .filter_map(|revisions| revisions.last())
            .take(usize::try_from(limit).expect("u32 fits in usize"))
            .map(|revision| PaperDraftSummary {
                paper_uuid: revision.paper_uuid.clone(),
                revision: revision.revision,
                created_at: "2026-08-15T00:00:00.000000Z".to_owned(),
                updated_at: revision.created_at.clone(),
            })
            .collect())
    }

    async fn find_draft(&self, paper_uuid: &str) -> Result<Option<PaperDraft>, StoreError> {
        let drafts = self.drafts.lock().expect("fake drafts should lock");
        Ok(drafts.get(paper_uuid).and_then(|revisions| {
            revisions.last().map(|revision| PaperDraft {
                paper_uuid: revision.paper_uuid.clone(),
                revision: revision.revision,
                source_markdown: revision.source_markdown.clone(),
                created_at: "2026-08-15T00:00:00.000000Z".to_owned(),
                updated_at: revision.created_at.clone(),
            })
        }))
    }

    async fn update_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        source_markdown: &str,
        _actor: &str,
    ) -> Result<Option<DraftUpdateOutcome>, StoreError> {
        let mut drafts = self.drafts.lock().expect("fake drafts should lock");
        let Some(revisions) = drafts.get_mut(paper_uuid) else {
            return Ok(None);
        };
        let current = revisions.last().expect("draft has a revision");
        if current.revision != expected_revision {
            if current.revision == expected_revision.saturating_add(1)
                && current.source_markdown == source_markdown
            {
                return Ok(Some(DraftUpdateOutcome {
                    draft: PaperDraft {
                        paper_uuid: current.paper_uuid.clone(),
                        revision: current.revision,
                        source_markdown: current.source_markdown.clone(),
                        created_at: "2026-08-15T00:00:00.000000Z".to_owned(),
                        updated_at: current.created_at.clone(),
                    },
                    replayed: true,
                }));
            }
            return Err(StoreError::DraftRevisionConflict {
                current_revision: current.revision,
            });
        }
        let revision_number = current.revision + 1;
        let created_at = format!("2026-08-15T00:00:{revision_number:02}.000000Z");
        let revision = PaperDraftRevision {
            paper_uuid: paper_uuid.to_owned(),
            revision: revision_number,
            source_markdown: source_markdown.to_owned(),
            created_at: created_at.clone(),
        };
        revisions.push(revision);
        if revisions.len() > usize::try_from(DRAFT_REVISION_RETENTION).expect("retention fits") {
            revisions.remove(0);
        }
        Ok(Some(DraftUpdateOutcome {
            draft: PaperDraft {
                paper_uuid: paper_uuid.to_owned(),
                revision: revision_number,
                source_markdown: source_markdown.to_owned(),
                created_at: "2026-08-15T00:00:00.000000Z".to_owned(),
                updated_at: created_at,
            },
            replayed: false,
        }))
    }

    async fn list_draft_revisions(
        &self,
        paper_uuid: &str,
    ) -> Result<Option<Vec<PaperDraftRevisionSummary>>, StoreError> {
        let drafts = self.drafts.lock().expect("fake drafts should lock");
        Ok(drafts.get(paper_uuid).map(|revisions| {
            revisions
                .iter()
                .rev()
                .map(PaperDraftRevisionSummary::from)
                .collect()
        }))
    }

    async fn find_draft_revision(
        &self,
        paper_uuid: &str,
        revision: u32,
    ) -> Result<Option<PaperDraftRevision>, StoreError> {
        let drafts = self.drafts.lock().expect("fake drafts should lock");
        Ok(drafts
            .get(paper_uuid)
            .and_then(|revisions| {
                revisions
                    .iter()
                    .find(|candidate| candidate.revision == revision)
            })
            .cloned())
    }

    async fn delete_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        _actor: &str,
    ) -> Result<bool, StoreError> {
        let mut drafts = self.drafts.lock().expect("fake drafts should lock");
        let Some(current_revision) = drafts
            .get(paper_uuid)
            .and_then(|revisions| revisions.last())
            .map(|revision| revision.revision)
        else {
            return Ok(false);
        };
        if current_revision != expected_revision {
            return Err(StoreError::DraftRevisionConflict { current_revision });
        }
        drafts.remove(paper_uuid);
        Ok(true)
    }

    async fn publish_new(
        &self,
        paper: PaperDocument,
        submitted_markdown: &str,
        _actor: &str,
        idempotency_key: &str,
        product_id: Option<&str>,
    ) -> Result<PublishOutcome, StoreError> {
        if let Some((existing_source, published)) = self
            .requests
            .lock()
            .expect("fake requests should lock")
            .get(idempotency_key)
        {
            if existing_source != submitted_markdown {
                return Err(StoreError::IdempotencyConflict);
            }
            return Ok(PublishOutcome {
                paper: published.clone(),
                replayed: true,
            });
        }
        let published = prepare_publication(
            paper,
            PublicationIdentity {
                paper_id: "prodxiv:2607.000001".to_owned(),
                revision: 1,
                published_at: "2026-07-27".to_owned(),
            },
            product_id
                .unwrap_or("prodxiv-product:2607.000001")
                .to_owned(),
        )
        .expect("valid test submission should publish");
        self.publications
            .lock()
            .expect("fake store should lock")
            .push(published.clone());
        self.requests
            .lock()
            .expect("fake requests should lock")
            .insert(
                idempotency_key.to_owned(),
                (submitted_markdown.to_owned(), published.clone()),
            );
        Ok(PublishOutcome {
            paper: published,
            replayed: false,
        })
    }

    async fn find_revision(
        &self,
        paper_id: &str,
        revision: u32,
    ) -> Result<Option<PublishedPaper>, StoreError> {
        Ok(self
            .publications
            .lock()
            .expect("fake store should lock")
            .iter()
            .find(|paper| paper.paper_id == paper_id && paper.revision == revision)
            .cloned())
    }

    async fn list_latest(
        &self,
        limit: u32,
        cursor: Option<&PublicationCursor>,
    ) -> Result<PublicationPage, StoreError> {
        let publications = self
            .publications
            .lock()
            .expect("fake store should lock")
            .clone();
        let mut entries = publications
            .iter()
            .enumerate()
            .map(|(index, paper)| {
                (
                    PublishedPaperSummary::from(paper),
                    PublicationCursor {
                        created_at_micros: i64::try_from(index + 1)
                            .expect("test publication count fits in i64"),
                        paper_id: paper.paper_id.clone(),
                    },
                )
            })
            .filter(|(_, item_cursor)| {
                cursor.is_none_or(|cursor| {
                    (item_cursor.created_at_micros, &item_cursor.paper_id)
                        < (cursor.created_at_micros, &cursor.paper_id)
                })
            })
            .collect::<Vec<_>>();
        entries.sort_by(|(_, left), (_, right)| {
            (right.created_at_micros, &right.paper_id)
                .cmp(&(left.created_at_micros, &left.paper_id))
        });
        let limit = usize::try_from(limit).expect("u32 fits in usize");
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

    async fn github_trending_view(
        &self,
        period: &str,
        language: &GitHubTrendingLanguageSelector,
        spoken_language: Option<&str>,
        snapshot_date: Option<&str>,
    ) -> Result<GitHubTrendingView, StoreError> {
        let snapshots = {
            let snapshots = self
                .github_trending
                .lock()
                .expect("fake Trending snapshot should lock");
            snapshots
                .iter()
                .filter(|snapshot| {
                    snapshot.period == period
                        && (matches!(language, GitHubTrendingLanguageSelector::All)
                            || snapshot.language.as_str() == language.as_str())
                        && snapshot.spoken_language.as_deref() == spoken_language
                        && snapshot_date.is_none_or(|date| snapshot.snapshot_date == date)
                })
                .cloned()
                .collect()
        };
        Ok(GitHubTrendingView {
            snapshots,
            previous_date: None,
            next_date: None,
            available_languages: vec!["rust".to_owned(), "typescript".to_owned()],
        })
    }

    async fn ingest_github_trending_snapshot(
        &self,
        snapshot: NewGitHubTrendingSnapshot,
        actor: &str,
        idempotency_key: &str,
    ) -> Result<TrendingImportOutcome, StoreError> {
        self.trending_actors
            .lock()
            .expect("fake Trending actors should lock")
            .push(actor.to_owned());
        if snapshot
            .entries
            .iter()
            .flat_map(|entry| [entry.stars, entry.forks, entry.stars_in_period])
            .flatten()
            .any(|value| value < 0)
        {
            return Err(StoreError::InvalidTrendingSnapshot(
                "repository counts must not be negative",
            ));
        }
        let serialized = serde_json::to_string(&snapshot).expect("fake snapshot should serialize");
        let mut requests = self
            .trending_requests
            .lock()
            .expect("fake Trending requests should lock");
        if let Some(previous) = requests.get(idempotency_key) {
            if previous != &serialized {
                return Err(StoreError::IdempotencyConflict);
            }
            return Ok(TrendingImportOutcome {
                snapshot_id: 42,
                entry_count: snapshot.entries.len(),
                inserted: false,
            });
        }
        requests.insert(idempotency_key.to_owned(), serialized);
        Ok(TrendingImportOutcome {
            snapshot_id: 42,
            entry_count: snapshot.entries.len(),
            inserted: true,
        })
    }
}

fn repository_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("API crate must be inside the workspace crates directory")
}

fn submission_markdown() -> String {
    let source = fs::read_to_string(repository_root().join("examples/papers/prodxiv.md"))
        .expect("exemplary paper should be readable");
    let mut paper = PaperDocument::from_markdown(&source).expect("exemplary paper should parse");
    paper.metadata.paper_id = None;
    paper.metadata.published_at = None;
    paper.metadata.revision = None;
    let metadata =
        serde_yaml::to_string(&paper.metadata).expect("submission metadata should serialize");
    format!("---\n{metadata}---\n{}", paper.markdown)
}

fn legacy_submission_markdown() -> String {
    let mut paper = PaperDocument::from_markdown(&submission_markdown())
        .expect("submission paper should parse");
    paper.metadata.schema_version = "1".to_owned();
    paper.metadata.writers.clear();
    paper.metadata.communication_email = None;
    for author in &mut paper.metadata.authors {
        author.id = None;
        author.kind = None;
    }
    paper.metadata.status = PaperStatus::Legacy(ProductStatus::Concept);
    let metadata =
        serde_yaml::to_string(&paper.metadata).expect("legacy metadata should serialize");
    format!("---\n{metadata}---\n{}", paper.markdown)
}

fn app(store: Arc<FakeStore>) -> axum::Router {
    router(
        AppState::new(store, TOKEN, "api_test")
            .with_trending_ingestion(Some(INGEST_TOKEN.to_owned())),
    )
}

async fn json_body(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body should be readable");
    serde_json::from_slice(&bytes).expect("response should contain JSON")
}

#[tokio::test]
async fn reads_the_latest_github_trending_snapshot() {
    let store = Arc::new(FakeStore {
        github_trending: Mutex::new(vec![GitHubTrendingSnapshot {
            snapshot_date: "2026-07-29".to_owned(),
            captured_at: None,
            period: "daily".to_owned(),
            language: GitHubTrendingLanguageScope::Any,
            spoken_language: None,
            source_kind: "third_party_archive".to_owned(),
            source_url: "https://example.com/archive".to_owned(),
            source_revision: "abc123".to_owned(),
            entries: vec![GitHubTrendingEntry {
                rank: 1,
                repository_full_name: "pascalorg/editor".to_owned(),
                repository_node_id: None,
                description: Some("A repository".to_owned()),
                primary_language: Some("TypeScript".to_owned()),
                stars: None,
                forks: None,
                stars_in_period: None,
            }],
        }]),
        ..FakeStore::default()
    });
    let response = app(store)
        .oneshot(
            Request::get("/v1/github/trending?period=daily")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["requested_language"], "any");
    assert_eq!(body["snapshots"][0]["snapshot_date"], "2026-07-29");
    assert_eq!(body["snapshots"][0]["language"], "any");
    assert_eq!(body["available_languages"][0], "rust");
    assert!(body["previous_date"].is_null());
    assert_eq!(
        body["snapshots"][0]["entries"][0]["repository_url"],
        "https://github.com/pascalorg/editor"
    );
}

#[tokio::test]
async fn reads_all_github_trending_language_scopes() {
    let snapshot = |language| GitHubTrendingSnapshot {
        snapshot_date: "2026-07-29".to_owned(),
        captured_at: None,
        period: "daily".to_owned(),
        language,
        spoken_language: None,
        source_kind: "third_party_archive".to_owned(),
        source_url: "https://example.com/archive".to_owned(),
        source_revision: "abc123".to_owned(),
        entries: Vec::new(),
    };
    let store = Arc::new(FakeStore {
        github_trending: Mutex::new(vec![
            snapshot(GitHubTrendingLanguageScope::Any),
            snapshot(GitHubTrendingLanguageScope::Language("rust".to_owned())),
        ]),
        ..FakeStore::default()
    });
    let response = app(store)
        .oneshot(
            Request::get("/v1/github/trending?period=daily&language=all")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["requested_language"], "all");
    assert_eq!(body["snapshots"].as_array().map(Vec::len), Some(2));
    assert_eq!(body["snapshots"][0]["language"], "any");
    assert_eq!(body["snapshots"][1]["language"], "rust");
}

#[tokio::test]
async fn ingests_a_trending_snapshot_idempotently() {
    let store = Arc::new(FakeStore::default());
    let application = app(store.clone());
    let request = || {
        Request::post("/v1/github/trending/snapshots")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {INGEST_TOKEN}"))
            .header("idempotency-key", "github-trending.test.rust")
            .header("x-prodxiv-actor", "github_actions:daily_trending")
            .body(Body::from(trending_snapshot_json().to_string()))
            .expect("request should build")
    };

    let first = application
        .clone()
        .oneshot(request())
        .await
        .expect("first ingestion should complete");
    let replay = application
        .oneshot(request())
        .await
        .expect("replayed ingestion should complete");

    assert_eq!(first.status(), StatusCode::CREATED);
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(json_body(first).await["inserted"], true);
    assert_eq!(json_body(replay).await["inserted"], false);
    assert_eq!(
        store
            .trending_requests
            .lock()
            .expect("fake Trending requests should lock")
            .len(),
        1
    );
    assert_eq!(
        store
            .trending_actors
            .lock()
            .expect("fake Trending actors should lock")
            .as_slice(),
        [
            "github_actions:daily_trending",
            "github_actions:daily_trending"
        ]
    );
}

#[tokio::test]
async fn rejects_all_as_an_ingested_language_scope() {
    let mut snapshot = trending_snapshot_json();
    snapshot["language"] = json!("all");
    let response = app(Arc::new(FakeStore::default()))
        .oneshot(
            Request::post("/v1/github/trending/snapshots")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {INGEST_TOKEN}"))
                .header("idempotency-key", "github-trending.test.all")
                .header("x-prodxiv-actor", "github_actions:daily_trending")
                .body(Body::from(snapshot.to_string()))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = json_body(response).await;
    assert_eq!(body["error"]["code"], "trending.snapshot_invalid");
    assert!(
        body["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("all is query-only"))
    );
}

#[tokio::test]
async fn protects_trending_ingestion_with_a_dedicated_token() {
    let response = app(Arc::new(FakeStore::default()))
        .oneshot(
            Request::post("/v1/github/trending/snapshots")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header("idempotency-key", "github-trending.test.unauthorized")
                .header("x-prodxiv-actor", "github_actions:daily_trending")
                .body(Body::from(trending_snapshot_json().to_string()))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn requires_a_trending_ingestion_actor() {
    let response = app(Arc::new(FakeStore::default()))
        .oneshot(
            Request::post("/v1/github/trending/snapshots")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {INGEST_TOKEN}"))
                .header("idempotency-key", "github-trending.test.actor")
                .body(Body::from(trending_snapshot_json().to_string()))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        json_body(response).await["error"]["code"],
        "request.invalid_ingestion_actor"
    );
}

#[tokio::test]
async fn keeps_reading_available_when_trending_ingestion_is_not_configured() {
    let application = router(AppState::new(
        Arc::new(FakeStore::default()),
        TOKEN,
        "api_test",
    ));
    let ingestion = application
        .clone()
        .oneshot(
            Request::post("/v1/github/trending/snapshots")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {INGEST_TOKEN}"))
                .header("idempotency-key", "github-trending.test.unconfigured")
                .header("x-prodxiv-actor", "github_actions:daily_trending")
                .body(Body::from(trending_snapshot_json().to_string()))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(ingestion.status(), StatusCode::SERVICE_UNAVAILABLE);

    let reading = application
        .oneshot(
            Request::get("/v1/github/trending?period=daily")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("read request should complete");
    assert_eq!(reading.status(), StatusCode::OK);
}

#[tokio::test]
async fn rejects_invalid_trending_snapshots_and_idempotency_conflicts() {
    let application = app(Arc::new(FakeStore::default()));
    let request = |body: Value| {
        Request::post("/v1/github/trending/snapshots")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {INGEST_TOKEN}"))
            .header("idempotency-key", "github-trending.test.conflict")
            .header("x-prodxiv-actor", "github_actions:daily_trending")
            .body(Body::from(body.to_string()))
            .expect("request should build")
    };

    let first = application
        .clone()
        .oneshot(request(trending_snapshot_json()))
        .await
        .expect("first request should complete");
    assert_eq!(first.status(), StatusCode::CREATED);

    let mut conflict = trending_snapshot_json();
    conflict["source_revision"] = json!("sha256:different");
    let conflict = application
        .clone()
        .oneshot(request(conflict))
        .await
        .expect("conflicting request should complete");
    assert_eq!(conflict.status(), StatusCode::CONFLICT);

    let mut invalid = trending_snapshot_json();
    invalid["entries"][0]["stars"] = json!(-1);
    let invalid = application
        .oneshot(
            Request::post("/v1/github/trending/snapshots")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {INGEST_TOKEN}"))
                .header("idempotency-key", "github-trending.test.invalid")
                .header("x-prodxiv-actor", "github_actions:daily_trending")
                .body(Body::from(invalid.to_string()))
                .expect("request should build"),
        )
        .await
        .expect("invalid request should complete");
    assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);
}

fn trending_snapshot_json() -> Value {
    json!({
      "snapshot_date": "2026-07-31",
      "captured_at": "2026-07-31T02:17:00Z",
      "period": "daily",
      "language": "rust",
      "spoken_language": null,
      "source_kind": "direct_fetch",
      "source_url": "https://github.com/trending/rust?since=daily",
      "source_revision": "sha256:example",
      "entries": [{
        "repository_full_name": "acme/rust",
        "repository_node_id": null,
        "description": "A useful tool",
        "primary_language": "Rust",
        "stars": 100,
        "forks": 10,
        "stars_in_period": 5
      }]
    })
}

#[tokio::test]
async fn publishing_requires_authorization() {
    let store = Arc::new(FakeStore::default());
    let response = app(store.clone())
        .oneshot(
            Request::post("/v1/papers")
                .header(header::CONTENT_TYPE, "application/json")
                .header("idempotency-key", "paperbot.test.unauthorized")
                .body(Body::from(
                    json!({ "source_markdown": submission_markdown() }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(
        store
            .publications
            .lock()
            .expect("fake store should lock")
            .is_empty()
    );
}

#[tokio::test]
async fn creates_updates_lists_and_deletes_a_uuid_scoped_draft() {
    let application = app(Arc::new(FakeStore::default()));
    let created = application
        .clone()
        .oneshot(
            Request::post("/v1/drafts")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::from(
                    json!({ "source_markdown": "# Working notes\n" }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("draft creation should complete");
    assert_eq!(created.status(), StatusCode::CREATED);
    assert_eq!(created.headers()[header::ETAG], "\"1\"");
    let location = created.headers()[header::LOCATION]
        .to_str()
        .expect("location should be text")
        .to_owned();
    let paper_uuid = location
        .strip_prefix("/v1/drafts/")
        .expect("location should identify a draft")
        .to_owned();
    let created_body = json_body(created).await;
    assert_eq!(created_body["paper_uuid"], paper_uuid);
    assert_eq!(created_body["revision"], 1);

    for expected_revision in 1..=6 {
        let response = application
            .clone()
            .oneshot(
                Request::put(&location)
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .header(header::IF_MATCH, format!("\"{expected_revision}\""))
                    .body(Body::from(
                        json!({
                          "source_markdown": format!("# Working notes {expected_revision}\n")
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("draft update should complete");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::ETAG],
            format!("\"{}\"", expected_revision + 1)
        );
    }

    let revisions = application
        .clone()
        .oneshot(
            Request::get(format!("{location}/revisions"))
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("draft revision list should complete");
    assert_eq!(revisions.status(), StatusCode::OK);
    let revisions = json_body(revisions).await;
    assert_eq!(revisions["retained_revision_limit"], 5);
    assert_eq!(revisions["revisions"].as_array().map(Vec::len), Some(5));
    assert_eq!(revisions["revisions"][0]["revision"], 7);
    assert_eq!(revisions["revisions"][4]["revision"], 3);

    let pruned = application
        .clone()
        .oneshot(
            Request::get(format!("{location}/revisions/1"))
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("pruned revision lookup should complete");
    assert_eq!(pruned.status(), StatusCode::NOT_FOUND);

    let listed = application
        .clone()
        .oneshot(
            Request::get("/v1/drafts")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("draft list should complete");
    let listed = json_body(listed).await;
    assert_eq!(listed["drafts"][0]["paper_uuid"], paper_uuid);
    assert_eq!(listed["drafts"][0]["revision"], 7);

    let deleted = application
        .clone()
        .oneshot(
            Request::delete(&location)
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"7\"")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("draft deletion should complete");
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);

    let missing = application
        .oneshot(
            Request::get(&location)
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("deleted draft lookup should complete");
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn accepts_two_mib_draft_sources_after_json_escaping() {
    const TWO_MIB: usize = 2 * 1024 * 1024;

    let application = app(Arc::new(FakeStore::default()));
    let source = format!("#{}", "\\".repeat(TWO_MIB - 1));
    assert_eq!(source.len(), TWO_MIB);
    let created = application
        .clone()
        .oneshot(
            Request::post("/v1/drafts")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::from(json!({ "source_markdown": source }).to_string()))
                .expect("request should build"),
        )
        .await
        .expect("maximum-size draft creation should complete");
    assert_eq!(created.status(), StatusCode::CREATED);
    let location = created.headers()[header::LOCATION]
        .to_str()
        .expect("location should be text")
        .to_owned();

    let revised_source = format!("!{}", "\\".repeat(TWO_MIB - 1));
    let updated = application
        .clone()
        .oneshot(
            Request::put(&location)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"1\"")
                .body(Body::from(
                    json!({ "source_markdown": revised_source }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("maximum-size draft update should complete");
    assert_eq!(updated.status(), StatusCode::OK);

    let oversized_source = format!("#{}", "x".repeat(TWO_MIB));
    let oversized = application
        .oneshot(
            Request::put(&location)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"2\"")
                .body(Body::from(
                    json!({ "source_markdown": oversized_source }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("oversized draft update should complete");
    assert_eq!(oversized.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        json_body(oversized).await["error"]["code"],
        "draft.source_too_large"
    );
}

#[tokio::test]
async fn protects_drafts_and_rejects_latest_or_stale_writes() {
    let application = app(Arc::new(FakeStore::default()));
    let unauthorized = application
        .clone()
        .oneshot(
            Request::get("/v1/drafts")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("unauthorized request should complete");
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let latest = application
        .clone()
        .oneshot(
            Request::get("/v1/drafts/latest")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("removed latest alias should complete");
    assert_eq!(latest.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        json_body(latest).await["error"]["code"],
        "draft.invalid_uuid"
    );

    let created = application
        .clone()
        .oneshot(
            Request::post("/v1/drafts")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::from(
                    json!({ "source_markdown": "first" }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("draft creation should complete");
    let location = created.headers()[header::LOCATION]
        .to_str()
        .expect("location should be text")
        .to_owned();
    let first_update = application
        .clone()
        .oneshot(
            Request::put(&location)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"1\"")
                .body(Body::from(
                    json!({ "source_markdown": "second" }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("draft update should complete");
    assert_eq!(first_update.status(), StatusCode::OK);

    let stale = application
        .oneshot(
            Request::put(&location)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"1\"")
                .body(Body::from(
                    json!({ "source_markdown": "conflicting edit" }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("stale update should complete");
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    assert_eq!(
        json_body(stale).await["error"]["code"],
        "draft.revision_conflict"
    );
}

#[tokio::test]
async fn publishes_and_reads_one_exact_revision() {
    let store = Arc::new(FakeStore::default());
    let application = app(store);
    let response = application
        .clone()
        .oneshot(
            Request::post("/v1/papers")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header("idempotency-key", "paperbot.test.publish")
                .body(Body::from(
                    json!({
                      "source_markdown": submission_markdown(),
                      "product_id": "prodxiv-product:2607.00000A"
                    })
                    .to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(
        response.headers().get(header::LOCATION),
        Some(
            &"/v1/papers/prodxiv:2607.000001/revisions/1"
                .parse()
                .unwrap()
        )
    );
    let body = json_body(response).await;
    assert_eq!(body["paper_id"], "prodxiv:2607.000001");
    assert_eq!(body["product_id"], "prodxiv-product:2607.00000A");
    assert_eq!(body["version"], 1);

    let response = application
        .oneshot(
            Request::get("/v1/papers/prodxiv:2607.000001/revisions/1")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["paper_id"], "prodxiv:2607.000001");
}

#[tokio::test]
async fn lists_latest_papers_without_authorization() {
    let store = Arc::new(FakeStore::default());
    let application = app(store);
    let publish_response = application
        .clone()
        .oneshot(
            Request::post("/v1/papers")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header("idempotency-key", "paperbot.test.list")
                .body(Body::from(
                    json!({ "source_markdown": submission_markdown() }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(publish_response.status(), StatusCode::CREATED);

    let response = application
        .oneshot(
            Request::get("/v1/papers?limit=10")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["papers"][0]["paper_id"], "prodxiv:2607.000001");
    assert_eq!(body["papers"][0]["version"], 1);
    assert!(body["papers"][0].get("source_markdown").is_none());
    assert!(body.get("next_cursor").is_none());
}

#[tokio::test]
async fn rejects_invalid_list_pagination() {
    let application = app(Arc::new(FakeStore::default()));
    for path in ["/v1/papers?limit=0", "/v1/papers?cursor=not-a-cursor"] {
        let response = application
            .clone()
            .oneshot(
                Request::get(path)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn rejects_server_owned_submission_metadata() {
    let source = fs::read_to_string(repository_root().join("examples/papers/prodxiv.md"))
        .expect("exemplary paper should be readable");
    let response = app(Arc::new(FakeStore::default()))
        .oneshot(
            Request::post("/v1/papers")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header("idempotency-key", "paperbot.test.invalid")
                .body(Body::from(json!({ "source_markdown": source }).to_string()))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = json_body(response).await;
    assert_eq!(body["error"]["code"], "paper.invalid");
    assert!(
        body["error"]["diagnostics"]
            .as_array()
            .expect("diagnostics should be an array")
            .iter()
            .any(|diagnostic| diagnostic["code"] == "submission.paper_id_forbidden")
    );
}

#[tokio::test]
async fn rejects_new_legacy_schema_submissions() {
    let response = app(Arc::new(FakeStore::default()))
        .oneshot(
            Request::post("/v1/papers")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header("idempotency-key", "paperbot.test.legacy")
                .body(Body::from(
                    json!({ "source_markdown": legacy_submission_markdown() }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = json_body(response).await;
    assert!(
        body["error"]["diagnostics"]
            .as_array()
            .expect("diagnostics should be an array")
            .iter()
            .any(|diagnostic| diagnostic["code"] == "submission.current_schema_required")
    );
}

#[tokio::test]
async fn requires_an_idempotency_key() {
    let response = app(Arc::new(FakeStore::default()))
        .oneshot(
            Request::post("/v1/papers")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::from(
                    json!({ "source_markdown": submission_markdown() }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        json_body(response).await["error"]["code"],
        "request.idempotency_key_required"
    );
}

#[tokio::test]
async fn returns_the_original_publication_for_an_idempotent_retry() {
    let store = Arc::new(FakeStore::default());
    let application = app(store.clone());
    let request = || {
        Request::post("/v1/papers")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .header("idempotency-key", "paperbot.test.retry")
            .body(Body::from(
                json!({ "source_markdown": submission_markdown() }).to_string(),
            ))
            .expect("request should build")
    };

    let first = application
        .clone()
        .oneshot(request())
        .await
        .expect("first request should complete");
    let second = application
        .oneshot(request())
        .await
        .expect("retry should complete");

    assert_eq!(first.status(), StatusCode::CREATED);
    assert_eq!(second.status(), StatusCode::OK);
    assert_eq!(
        store
            .publications
            .lock()
            .expect("fake store should lock")
            .len(),
        1
    );
}

#[tokio::test]
async fn rejects_an_idempotency_key_reused_for_different_content() {
    let application = app(Arc::new(FakeStore::default()));
    let source = submission_markdown();
    let request = |source: String| {
        Request::post("/v1/papers")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .header("idempotency-key", "paperbot.test.conflict")
            .body(Body::from(json!({ "source_markdown": source }).to_string()))
            .expect("request should build")
    };

    let first = application
        .clone()
        .oneshot(request(source.clone()))
        .await
        .expect("first request should complete");
    let conflict = application
        .oneshot(request(format!("{source}\n")))
        .await
        .expect("conflicting request should complete");

    assert_eq!(first.status(), StatusCode::CREATED);
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    assert_eq!(
        json_body(conflict).await["error"]["code"],
        "publication.idempotency_conflict"
    );
}
