use std::{
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
use prodxiv_domain::{PaperDocument, PublicationIdentity, PublishedPaper, prepare_publication};
use serde_json::{Value, json};
use tower::ServiceExt;

const TOKEN: &str = "test_token_with_at_least_32_characters";

#[derive(Default)]
struct FakeStore {
    publications: Mutex<Vec<PublishedPaper>>,
}

#[async_trait]
impl PublicationStore for FakeStore {
    async fn publish_new(
        &self,
        paper: PaperDocument,
        _submitted_markdown: &str,
        _actor: &str,
    ) -> Result<PublishedPaper, StoreError> {
        let published = prepare_publication(
            paper,
            PublicationIdentity {
                paper_id: "prodxiv:2607.000001".to_owned(),
                version: 1,
                published_at: "2026-07-27".to_owned(),
            },
        )
        .expect("valid test submission should publish");
        self.publications
            .lock()
            .expect("fake store should lock")
            .push(published.clone());
        Ok(published)
    }

    async fn find_version(
        &self,
        paper_id: &str,
        version: u32,
    ) -> Result<Option<PublishedPaper>, StoreError> {
        Ok(self
            .publications
            .lock()
            .expect("fake store should lock")
            .iter()
            .find(|paper| paper.paper_id == paper_id && paper.version == version)
            .cloned())
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
    paper.metadata.version = None;
    let metadata =
        serde_yaml::to_string(&paper.metadata).expect("submission metadata should serialize");
    format!("---\n{metadata}---\n{}", paper.markdown)
}

fn app(store: Arc<FakeStore>) -> axum::Router {
    router(AppState::new(store, TOKEN, "api_test"))
}

async fn json_body(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body should be readable");
    serde_json::from_slice(&bytes).expect("response should contain JSON")
}

#[tokio::test]
async fn publishing_requires_authorization() {
    let store = Arc::new(FakeStore::default());
    let response = app(store.clone())
        .oneshot(
            Request::post("/v1/papers")
                .header(header::CONTENT_TYPE, "application/json")
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
async fn publishes_and_reads_one_exact_version() {
    let store = Arc::new(FakeStore::default());
    let application = app(store);
    let response = application
        .clone()
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

    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(
        response.headers().get(header::LOCATION),
        Some(&"/v1/papers/prodxiv:2607.000001/versions/1".parse().unwrap())
    );
    let body = json_body(response).await;
    assert_eq!(body["paper_id"], "prodxiv:2607.000001");
    assert_eq!(body["version"], 1);

    let response = application
        .oneshot(
            Request::get("/v1/papers/prodxiv:2607.000001/versions/1")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["paper_id"], "prodxiv:2607.000001");
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
