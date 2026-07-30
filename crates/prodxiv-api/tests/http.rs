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
    PaperDocument, PublicationIdentity, PublishedPaper, PublishedPaperSummary, prepare_publication,
};
use prodxiv_storage::{
    GitHubTrendingEntry, GitHubTrendingSnapshot, GitHubTrendingView, NewGitHubTrendingSnapshot,
    PublicationCursor, PublicationPage, PublishOutcome, TrendingImportOutcome,
};
use serde_json::{Value, json};
use tower::ServiceExt;

const TOKEN: &str = "test_token_with_at_least_32_characters";
const INGEST_TOKEN: &str = "trending_ingest_token_with_32_characters";

#[derive(Default)]
struct FakeStore {
    publications: Mutex<Vec<PublishedPaper>>,
    requests: Mutex<HashMap<String, (String, PublishedPaper)>>,
    trending_requests: Mutex<HashMap<String, String>>,
    github_trending: Mutex<Option<GitHubTrendingSnapshot>>,
}

#[async_trait]
impl PublicationStore for FakeStore {
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
        language: Option<&str>,
        spoken_language: Option<&str>,
        snapshot_date: Option<&str>,
    ) -> Result<GitHubTrendingView, StoreError> {
        let snapshot = self
            .github_trending
            .lock()
            .expect("fake Trending snapshot should lock")
            .as_ref()
            .filter(|snapshot| {
                snapshot.period == period
                    && snapshot.language.as_deref() == language
                    && snapshot.spoken_language.as_deref() == spoken_language
                    && snapshot_date.is_none_or(|date| snapshot.snapshot_date == date)
            })
            .cloned();
        Ok(GitHubTrendingView {
            snapshot,
            previous_date: None,
            next_date: None,
            available_languages: vec!["rust".to_owned(), "typescript".to_owned()],
        })
    }

    async fn ingest_github_trending_snapshot(
        &self,
        snapshot: NewGitHubTrendingSnapshot,
        _actor: &str,
        idempotency_key: &str,
    ) -> Result<TrendingImportOutcome, StoreError> {
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

fn app(store: Arc<FakeStore>) -> axum::Router {
    router(
        AppState::new(store, TOKEN, "api_test")
            .with_trending_ingestion(Some(INGEST_TOKEN.to_owned()), "trending_test"),
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
        github_trending: Mutex::new(Some(GitHubTrendingSnapshot {
            snapshot_date: "2026-07-29".to_owned(),
            captured_at: None,
            period: "daily".to_owned(),
            language: None,
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
        })),
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
    assert_eq!(body["snapshot"]["snapshot_date"], "2026-07-29");
    assert_eq!(body["available_languages"][0], "rust");
    assert!(body["previous_date"].is_null());
    assert_eq!(
        body["snapshot"]["entries"][0]["repository_url"],
        "https://github.com/pascalorg/editor"
    );
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
}

#[tokio::test]
async fn protects_trending_ingestion_with_a_dedicated_token() {
    let response = app(Arc::new(FakeStore::default()))
        .oneshot(
            Request::post("/v1/github/trending/snapshots")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header("idempotency-key", "github-trending.test.unauthorized")
                .body(Body::from(trending_snapshot_json().to_string()))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
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
