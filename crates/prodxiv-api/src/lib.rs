//! Authoritative HTTP API for publishing and reading prodxiv papers.

use std::{
    env,
    net::{AddrParseError, SocketAddr},
    sync::Arc,
};

use async_trait::async_trait;
use axum::{
    Json, Router,
    extract::{Path, Query, State, rejection::JsonRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use prodxiv_domain::{
    Diagnostic, PaperDocument, PublishedPaper, PublishedPaperSummary, ValidationProfile,
    ValidationReport, canonicalize_paper_id, validate_paper,
};
use prodxiv_storage::{
    GitHubTrendingEntry, GitHubTrendingSnapshot, GitHubTrendingView, NewGitHubTrendingEntry,
    NewGitHubTrendingSnapshot, PostgresStorage, PublicationCursor, PublicationPage, PublishOutcome,
    StorageError, TrendingImportOutcome, is_valid_idempotency_key,
};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use thiserror::Error;
use tower_http::trace::TraceLayer;
use utoipa::{
    Modify, OpenApi, ToSchema,
    openapi::security::{Http, HttpAuthScheme, SecurityScheme},
};

#[derive(Clone)]
pub struct AppState {
    store: Arc<dyn PublicationStore>,
    publish_token: Arc<str>,
    publish_actor: Arc<str>,
    trending_ingest_token: Option<Arc<str>>,
}

impl AppState {
    #[must_use]
    pub fn new(
        store: Arc<dyn PublicationStore>,
        publish_token: impl Into<Arc<str>>,
        publish_actor: impl Into<Arc<str>>,
    ) -> Self {
        Self {
            store,
            publish_token: publish_token.into(),
            publish_actor: publish_actor.into(),
            trending_ingest_token: None,
        }
    }

    #[must_use]
    pub fn with_trending_ingestion(mut self, token: Option<String>) -> Self {
        self.trending_ingest_token = token.map(Arc::from);
        self
    }
}

#[derive(Debug, Clone)]
pub struct ApiConfig {
    pub bind_address: SocketAddr,
    pub database_url: String,
    pub migration_database_url: String,
    pub publish_token: String,
    pub publish_actor: String,
    pub trending_ingest_token: Option<String>,
}

impl ApiConfig {
    /// Loads API configuration from environment variables.
    ///
    /// # Errors
    ///
    /// Returns an error when a required value is absent, the token is too
    /// short, or the bind address is invalid.
    pub fn from_env() -> Result<Self, ConfigError> {
        let database_url =
            env::var("DATABASE_URL").map_err(|_| ConfigError::Missing("DATABASE_URL"))?;
        let migration_database_url = migration_database_url_from_env()?;
        let publish_token = env::var("PRODXIV_PUBLISH_TOKEN")
            .map_err(|_| ConfigError::Missing("PRODXIV_PUBLISH_TOKEN"))?;
        if publish_token.len() < 32 {
            return Err(ConfigError::WeakPublishToken);
        }
        let publish_actor =
            env::var("PRODXIV_PUBLISH_ACTOR").unwrap_or_else(|_| "mvp_publisher".to_owned());
        if publish_actor.trim().is_empty() {
            return Err(ConfigError::EmptyPublishActor);
        }
        let trending_ingest_token = env::var("PRODXIV_TRENDING_INGEST_TOKEN")
            .ok()
            .filter(|token| !token.trim().is_empty());
        if trending_ingest_token
            .as_ref()
            .is_some_and(|token| token.len() < 32)
        {
            return Err(ConfigError::WeakTrendingIngestToken);
        }
        if trending_ingest_token.as_deref() == Some(publish_token.as_str()) {
            return Err(ConfigError::ReusedTrendingIngestToken);
        }
        let bind_address = resolve_bind_address(
            env::var("PRODXIV_BIND_ADDRESS").ok().as_deref(),
            env::var("PORT").ok().as_deref(),
        )?;

        Ok(Self {
            bind_address,
            database_url,
            migration_database_url,
            publish_token,
            publish_actor,
            trending_ingest_token,
        })
    }
}

/// Loads the direct PostgreSQL URL used by startup and standalone migrations.
///
/// `DIRECT_DATABASE_URL` is accepted for local and provider-neutral
/// configuration. `DATABASE_URL_UNPOOLED` matches the variable injected by the
/// Neon Vercel integration.
///
/// # Errors
///
/// Returns an error when neither direct connection variable is configured.
pub fn migration_database_url_from_env() -> Result<String, ConfigError> {
    resolve_migration_database_url(
        env::var("DIRECT_DATABASE_URL").ok(),
        env::var("DATABASE_URL_UNPOOLED").ok(),
    )
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("required environment variable {0} is missing")]
    Missing(&'static str),
    #[error("PRODXIV_PUBLISH_TOKEN must contain at least 32 characters")]
    WeakPublishToken,
    #[error("PRODXIV_PUBLISH_ACTOR must not be empty")]
    EmptyPublishActor,
    #[error("PRODXIV_TRENDING_INGEST_TOKEN must contain at least 32 characters")]
    WeakTrendingIngestToken,
    #[error("PRODXIV_TRENDING_INGEST_TOKEN must differ from PRODXIV_PUBLISH_TOKEN")]
    ReusedTrendingIngestToken,
    #[error("PRODXIV_BIND_ADDRESS is invalid: {0}")]
    InvalidBindAddress(#[from] AddrParseError),
}

fn resolve_bind_address(
    configured_address: Option<&str>,
    vercel_port: Option<&str>,
) -> Result<SocketAddr, ConfigError> {
    configured_address
        .map(str::to_owned)
        .or_else(|| vercel_port.map(|port| format!("0.0.0.0:{port}")))
        .unwrap_or_else(|| "0.0.0.0:3000".to_owned())
        .parse()
        .map_err(ConfigError::from)
}

fn resolve_migration_database_url(
    direct_database_url: Option<String>,
    database_url_unpooled: Option<String>,
) -> Result<String, ConfigError> {
    direct_database_url
        .or(database_url_unpooled)
        .ok_or(ConfigError::Missing(
            "DIRECT_DATABASE_URL or DATABASE_URL_UNPOOLED",
        ))
}

#[async_trait]
pub trait PublicationStore: Send + Sync {
    async fn publish_new(
        &self,
        paper: PaperDocument,
        submitted_markdown: &str,
        actor: &str,
        idempotency_key: &str,
        product_id: Option<&str>,
    ) -> Result<PublishOutcome, StoreError>;

    async fn find_revision(
        &self,
        paper_id: &str,
        revision: u32,
    ) -> Result<Option<PublishedPaper>, StoreError>;

    async fn list_latest(
        &self,
        limit: u32,
        cursor: Option<&PublicationCursor>,
    ) -> Result<PublicationPage, StoreError>;

    async fn github_trending_view(
        &self,
        period: &str,
        language: Option<&str>,
        spoken_language: Option<&str>,
        snapshot_date: Option<&str>,
    ) -> Result<GitHubTrendingView, StoreError>;

    async fn ingest_github_trending_snapshot(
        &self,
        snapshot: NewGitHubTrendingSnapshot,
        actor: &str,
        idempotency_key: &str,
    ) -> Result<TrendingImportOutcome, StoreError>;
}

#[async_trait]
impl PublicationStore for PostgresStorage {
    async fn publish_new(
        &self,
        paper: PaperDocument,
        submitted_markdown: &str,
        actor: &str,
        idempotency_key: &str,
        product_id: Option<&str>,
    ) -> Result<PublishOutcome, StoreError> {
        PostgresStorage::publish_new(
            self,
            paper,
            submitted_markdown,
            actor,
            idempotency_key,
            product_id,
        )
        .await
        .map_err(StoreError::from)
    }

    async fn find_revision(
        &self,
        paper_id: &str,
        revision: u32,
    ) -> Result<Option<PublishedPaper>, StoreError> {
        PostgresStorage::find_revision(self, paper_id, revision)
            .await
            .map_err(StoreError::from)
    }

    async fn list_latest(
        &self,
        limit: u32,
        cursor: Option<&PublicationCursor>,
    ) -> Result<PublicationPage, StoreError> {
        PostgresStorage::list_latest(self, limit, cursor)
            .await
            .map_err(StoreError::from)
    }

    async fn github_trending_view(
        &self,
        period: &str,
        language: Option<&str>,
        spoken_language: Option<&str>,
        snapshot_date: Option<&str>,
    ) -> Result<GitHubTrendingView, StoreError> {
        PostgresStorage::github_trending_view(
            self,
            period,
            language,
            spoken_language,
            snapshot_date,
        )
        .await
        .map_err(StoreError::from)
    }

    async fn ingest_github_trending_snapshot(
        &self,
        snapshot: NewGitHubTrendingSnapshot,
        actor: &str,
        idempotency_key: &str,
    ) -> Result<TrendingImportOutcome, StoreError> {
        PostgresStorage::ingest_github_trending_snapshot(self, &snapshot, actor, idempotency_key)
            .await
            .map_err(StoreError::from)
    }
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("finalized publication is invalid")]
    InvalidPublication(ValidationReport),
    #[error("paper identifier space for the current month is exhausted")]
    IdentifierSpaceExhausted,
    #[error("idempotency key was already used for different content")]
    IdempotencyConflict,
    #[error("product identifier is invalid or does not exist")]
    InvalidProduct,
    #[error("GitHub Trending snapshot is invalid: {0}")]
    InvalidTrendingSnapshot(&'static str),
    #[error("storage operation failed")]
    Internal,
}

impl From<StorageError> for StoreError {
    fn from(error: StorageError) -> Self {
        match error {
            StorageError::Publication(prodxiv_domain::PublicationPreparationError::Invalid(
                report,
            )) => Self::InvalidPublication(report),
            StorageError::IdentifierSpaceExhausted { .. } => Self::IdentifierSpaceExhausted,
            StorageError::IdempotencyConflict => Self::IdempotencyConflict,
            StorageError::Database(_)
            | StorageError::Migration(_)
            | StorageError::Publication(prodxiv_domain::PublicationPreparationError::Serialize(
                _,
            ))
            | StorageError::InvalidActor
            | StorageError::InvalidIdempotencyKey
            | StorageError::CorruptRevision(_)
            | StorageError::TrendingSerialization(_)
            | StorageError::CorruptTrendingRank(_) => {
                tracing::error!(error = %error, "publication storage operation failed");
                Self::Internal
            }
            StorageError::InvalidProductId | StorageError::UnknownProduct(_) => {
                Self::InvalidProduct
            }
            StorageError::InvalidTrendingSnapshot(message) => {
                Self::InvalidTrendingSnapshot(message)
            }
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PublishPaperRequest {
    pub source_markdown: String,
    #[serde(default)]
    pub product_id: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct IngestGitHubTrendingRequest {
    pub snapshot_date: String,
    #[serde(default)]
    pub captured_at: Option<String>,
    pub period: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub spoken_language: Option<String>,
    pub source_kind: String,
    pub source_url: String,
    pub source_revision: String,
    pub entries: Vec<IngestGitHubTrendingEntry>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct IngestGitHubTrendingEntry {
    pub repository_full_name: String,
    #[serde(default)]
    pub repository_node_id: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub primary_language: Option<String>,
    #[serde(default)]
    pub stars: Option<i64>,
    #[serde(default)]
    pub forks: Option<i64>,
    #[serde(default)]
    pub stars_in_period: Option<i64>,
}

impl From<IngestGitHubTrendingRequest> for NewGitHubTrendingSnapshot {
    fn from(snapshot: IngestGitHubTrendingRequest) -> Self {
        Self {
            snapshot_date: snapshot.snapshot_date,
            captured_at: snapshot.captured_at,
            period: snapshot.period,
            language: snapshot.language,
            spoken_language: snapshot.spoken_language,
            source_kind: snapshot.source_kind,
            source_url: snapshot.source_url,
            source_revision: snapshot.source_revision,
            entries: snapshot.entries.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<IngestGitHubTrendingEntry> for NewGitHubTrendingEntry {
    fn from(entry: IngestGitHubTrendingEntry) -> Self {
        Self {
            repository_full_name: entry.repository_full_name,
            repository_node_id: entry.repository_node_id,
            description: entry.description,
            primary_language: entry.primary_language,
            stars: entry.stars,
            forks: entry.forks,
            stars_in_period: entry.stars_in_period,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GitHubTrendingIngestionResponse {
    pub snapshot_id: i64,
    pub entry_count: usize,
    pub inserted: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct HealthResponse {
    pub status: &'static str,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorResponse {
    pub error: ErrorBody,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    body: ErrorBody,
}

impl ApiError {
    fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            body: ErrorBody {
                code: code.to_owned(),
                message: message.into(),
                diagnostics: Vec::new(),
            },
        }
    }

    fn validation(report: ValidationReport) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            body: ErrorBody {
                code: "paper.invalid".to_owned(),
                message: "paper submission failed validation".to_owned(),
                diagnostics: report.diagnostics,
            },
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(ErrorResponse { error: self.body })).into_response()
    }
}

#[derive(Debug, Deserialize)]
struct RevisionPath {
    paper_id: String,
    revision: u32,
}

#[derive(Debug, Deserialize)]
struct ListPapersQuery {
    limit: Option<u32>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubTrendingQuery {
    date: Option<String>,
    period: Option<String>,
    language: Option<String>,
    spoken_language: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PaperListResponse {
    pub papers: Vec<PublishedPaperSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GitHubTrendingResponse {
    pub snapshot: Option<GitHubTrendingSnapshotResponse>,
    pub previous_date: Option<String>,
    pub next_date: Option<String>,
    pub available_languages: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GitHubTrendingSnapshotResponse {
    pub snapshot_date: String,
    pub captured_at: Option<String>,
    pub period: String,
    pub language: Option<String>,
    pub spoken_language: Option<String>,
    pub source_kind: String,
    pub source_url: String,
    pub source_revision: String,
    pub entries: Vec<GitHubTrendingEntryResponse>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GitHubTrendingEntryResponse {
    pub rank: u32,
    pub repository_full_name: String,
    pub repository_node_id: Option<String>,
    pub repository_url: String,
    pub description: Option<String>,
    pub primary_language: Option<String>,
    pub stars: Option<i64>,
    pub forks: Option<i64>,
    pub stars_in_period: Option<i64>,
}

impl From<GitHubTrendingSnapshot> for GitHubTrendingSnapshotResponse {
    fn from(snapshot: GitHubTrendingSnapshot) -> Self {
        Self {
            snapshot_date: snapshot.snapshot_date,
            captured_at: snapshot.captured_at,
            period: snapshot.period,
            language: snapshot.language,
            spoken_language: snapshot.spoken_language,
            source_kind: snapshot.source_kind,
            source_url: snapshot.source_url,
            source_revision: snapshot.source_revision,
            entries: snapshot.entries.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<GitHubTrendingEntry> for GitHubTrendingEntryResponse {
    fn from(entry: GitHubTrendingEntry) -> Self {
        Self {
            repository_url: format!("https://github.com/{}", entry.repository_full_name),
            rank: entry.rank,
            repository_full_name: entry.repository_full_name,
            repository_node_id: entry.repository_node_id,
            description: entry.description,
            primary_language: entry.primary_language,
            stars: entry.stars,
            forks: entry.forks,
            stars_in_period: entry.stars_in_period,
        }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/papers", get(list_papers).post(publish_paper))
        .route(
            "/v1/papers/{paper_id}/revisions/{revision}",
            get(get_paper_revision),
        )
        .route(
            "/v1/papers/{paper_id}/versions/{revision}",
            get(get_paper_revision),
        )
        .route("/v1/github/trending", get(get_github_trending))
        .route(
            "/v1/github/trending/snapshots",
            post(ingest_github_trending_snapshot),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[utoipa::path(
    post,
    path = "/v1/github/trending/snapshots",
    security(("bearer_token" = [])),
    params(
      (
        "Idempotency-Key" = String,
        Header,
        description = "Stable key for safely retrying one exact snapshot"
      ),
      (
        "X-Prodxiv-Actor" = String,
        Header,
        description = "Authenticated client's audit actor"
      )
    ),
    request_body = IngestGitHubTrendingRequest,
    responses(
      (status = 201, description = "Snapshot was ingested", body = GitHubTrendingIngestionResponse),
      (status = 200, description = "Original snapshot returned for an idempotent retry", body = GitHubTrendingIngestionResponse),
      (status = 400, description = "JSON or idempotency key is invalid", body = ErrorResponse),
      (status = 401, description = "Bearer token is absent or invalid", body = ErrorResponse),
      (status = 409, description = "Idempotency key was reused for different content", body = ErrorResponse),
      (status = 422, description = "Snapshot is invalid", body = ErrorResponse),
      (status = 500, description = "Ingestion failed", body = ErrorResponse),
      (status = 503, description = "Snapshot ingestion is not configured", body = ErrorResponse)
    )
)]
async fn ingest_github_trending_snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<IngestGitHubTrendingRequest>, JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    let token = state.trending_ingest_token.as_deref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "trending.ingestion_unavailable",
            "GitHub Trending ingestion is not configured",
        )
    })?;
    authorize(&headers, token)?;
    let idempotency_key = idempotency_key(&headers)?;
    let actor = ingestion_actor(&headers)?;
    let Json(payload) = payload.map_err(|error| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "request.invalid_json",
            error.body_text(),
        )
    })?;
    let outcome = state
        .store
        .ingest_github_trending_snapshot(payload.into(), actor, idempotency_key)
        .await
        .map_err(trending_store_error)?;
    let status = if outcome.inserted {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((
        status,
        Json(GitHubTrendingIngestionResponse {
            snapshot_id: outcome.snapshot_id,
            entry_count: outcome.entry_count,
            inserted: outcome.inserted,
        }),
    ))
}

#[utoipa::path(
    get,
    path = "/v1/github/trending",
    params(
      ("period" = Option<String>, Query, description = "daily, weekly, or monthly; defaults to daily"),
      ("date" = Option<String>, Query, description = "Exact snapshot date in YYYY-MM-DD form; defaults to latest"),
      ("language" = Option<String>, Query, description = "Exact GitHub Trending language scope"),
      ("spoken_language" = Option<String>, Query, description = "Exact GitHub Trending spoken-language scope")
    ),
    responses(
      (status = 200, description = "Latest imported snapshot for the requested scope", body = GitHubTrendingResponse),
      (status = 400, description = "Trending scope is invalid", body = ErrorResponse),
      (status = 500, description = "Reading failed", body = ErrorResponse)
    )
)]
async fn get_github_trending(
    State(state): State<AppState>,
    Query(query): Query<GitHubTrendingQuery>,
) -> Result<Json<GitHubTrendingResponse>, ApiError> {
    let period = query.period.as_deref().unwrap_or("daily");
    if !matches!(period, "daily" | "weekly" | "monthly") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "request.invalid_trending_period",
            "period must be daily, weekly, or monthly",
        ));
    }
    let language = normalized_scope(query.language.as_deref());
    let spoken_language = normalized_scope(query.spoken_language.as_deref());
    let snapshot_date = normalized_scope(query.date.as_deref());
    if snapshot_date.is_some_and(|value| !is_iso_date(value)) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "request.invalid_trending_date",
            "date must be a real calendar date in YYYY-MM-DD form",
        ));
    }
    let view = state
        .store
        .github_trending_view(period, language, spoken_language, snapshot_date)
        .await
        .map_err(store_error)?;
    Ok(Json(GitHubTrendingResponse {
        snapshot: view.snapshot.map(Into::into),
        previous_date: view.previous_date,
        next_date: view.next_date,
        available_languages: view.available_languages,
    }))
}

fn normalized_scope(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn is_iso_date(value: &str) -> bool {
    let parts = value
        .split('-')
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>();
    let Ok(parts) = parts else {
        return false;
    };
    if parts.len() != 3 || value.len() != 10 {
        return false;
    }
    let (year, month, day) = (parts[0], parts[1], parts[2]);
    let leap_year =
        year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap_year => 29,
        2 => 28,
        _ => return false,
    };
    (1..=max_day).contains(&day)
}

#[utoipa::path(
    get,
    path = "/health",
    responses(
        (status = 200, description = "API process is running", body = HealthResponse)
    )
)]
async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

#[utoipa::path(
    get,
    path = "/v1/papers",
    params(
      ("limit" = Option<u32>, Query, minimum = 1, maximum = 100, description = "Maximum papers to return; defaults to 20"),
      ("cursor" = Option<String>, Query, description = "Opaque cursor returned by the previous page")
    ),
    responses(
      (status = 200, description = "Latest published paper revisions", body = PaperListResponse),
      (status = 400, description = "Pagination parameters are invalid", body = ErrorResponse),
      (status = 500, description = "Reading failed", body = ErrorResponse)
    )
)]
async fn list_papers(
    State(state): State<AppState>,
    Query(query): Query<ListPapersQuery>,
) -> Result<Json<PaperListResponse>, ApiError> {
    let limit = query.limit.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "request.invalid_limit",
            "limit must be between 1 and 100",
        ));
    }
    let cursor = query
        .cursor
        .as_deref()
        .map(decode_publication_cursor)
        .transpose()?;
    let page = state
        .store
        .list_latest(limit, cursor.as_ref())
        .await
        .map_err(store_error)?;
    Ok(Json(PaperListResponse {
        papers: page.papers,
        next_cursor: page.next_cursor.as_ref().map(encode_publication_cursor),
    }))
}

#[utoipa::path(
    post,
    path = "/v1/papers",
    security(("bearer_token" = [])),
    params(
      (
        "Idempotency-Key" = String,
        Header,
        description = "Stable key for safely retrying one exact publication request"
      )
    ),
    request_body = PublishPaperRequest,
    responses(
      (status = 201, description = "Paper was published", body = PublishedPaper),
      (status = 200, description = "Original publication returned for an idempotent retry", body = PublishedPaper),
      (status = 400, description = "Request or idempotency key is invalid", body = ErrorResponse),
      (status = 401, description = "Bearer token is absent or invalid", body = ErrorResponse),
      (status = 409, description = "Idempotency key was reused for different content", body = ErrorResponse),
        (status = 422, description = "Paper is malformed or invalid", body = ErrorResponse),
        (status = 500, description = "Publishing failed", body = ErrorResponse),
        (status = 503, description = "Monthly identifier space is exhausted", body = ErrorResponse)
    )
)]
async fn publish_paper(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<PublishPaperRequest>, JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    authorize(&headers, &state.publish_token)?;
    let idempotency_key = idempotency_key(&headers)?;
    let Json(payload) = payload.map_err(|error| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "request.invalid_json",
            error.body_text(),
        )
    })?;
    let paper = PaperDocument::from_markdown(&payload.source_markdown).map_err(|error| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "paper.invalid_markdown",
            error.to_string(),
        )
    })?;
    let report = validate_paper(&paper, ValidationProfile::Submission);
    if !report.valid {
        return Err(ApiError::validation(report));
    }

    let outcome = state
        .store
        .publish_new(
            paper,
            &payload.source_markdown,
            &state.publish_actor,
            idempotency_key,
            payload.product_id.as_deref(),
        )
        .await
        .map_err(store_error)?;
    let published = outcome.paper;
    let location = format!(
        "/v1/papers/{}/revisions/{}",
        published.paper_id, published.revision
    );
    let status = if outcome.replayed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    let mut response = (status, Json(published)).into_response();
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(&location).expect("paper locations contain valid header characters"),
    );
    Ok(response)
}

fn idempotency_key(headers: &HeaderMap) -> Result<&str, ApiError> {
    let key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "request.idempotency_key_required",
                "Idempotency-Key header is required",
            )
        })?;
    if is_valid_idempotency_key(key) {
        Ok(key)
    } else {
        Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "request.idempotency_key_invalid",
            "Idempotency-Key must contain 8 to 128 letters, digits, '.', '_', '-', or ':'",
        ))
    }
}

fn ingestion_actor(headers: &HeaderMap) -> Result<&str, ApiError> {
    let actor = headers
        .get("x-prodxiv-actor")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric()
                        || matches!(byte, b'-' | b'_' | b'.' | b':' | b'@' | b'/')
                })
        })
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "request.invalid_ingestion_actor",
                "X-Prodxiv-Actor must contain 1 to 128 safe identifier characters",
            )
        })?;
    Ok(actor)
}

#[utoipa::path(
    get,
    path = "/v1/papers/{paper_id}/revisions/{revision}",
    params(
        ("paper_id" = String, Path, description = "Canonical prodxiv paper identifier"),
        ("revision" = u32, Path, minimum = 1)
    ),
    responses(
        (status = 200, description = "Exact immutable paper revision", body = PublishedPaper),
        (status = 400, description = "Paper identifier or revision is invalid", body = ErrorResponse),
        (status = 404, description = "Paper revision does not exist", body = ErrorResponse),
        (status = 500, description = "Reading failed", body = ErrorResponse)
    )
)]
async fn get_paper_revision(
    State(state): State<AppState>,
    Path(path): Path<RevisionPath>,
) -> Result<Json<PublishedPaper>, ApiError> {
    let paper_id = canonicalize_paper_id(&path.paper_id).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "paper.invalid_id",
            "paper identifier must match prodxiv:YYMM.XXXXXX using Crockford Base32",
        )
    })?;
    if path.revision == 0 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "paper.invalid_revision",
            "paper revision must be positive",
        ));
    }

    let published = state
        .store
        .find_revision(&paper_id, path.revision)
        .await
        .map_err(store_error)?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "paper.not_found",
                "paper revision does not exist",
            )
        })?;
    Ok(Json(published))
}

fn encode_publication_cursor(cursor: &PublicationCursor) -> String {
    let mut bytes = cursor.created_at_micros.to_be_bytes().to_vec();
    bytes.extend_from_slice(cursor.paper_id.as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_publication_cursor(value: &str) -> Result<PublicationCursor, ApiError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| invalid_cursor())?;
    let (micros, paper_id) = bytes.split_at_checked(8).ok_or_else(invalid_cursor)?;
    let created_at_micros =
        i64::from_be_bytes(micros.try_into().expect("cursor timestamp is eight bytes"));
    let paper_id = std::str::from_utf8(paper_id).map_err(|_| invalid_cursor())?;
    let paper_id = canonicalize_paper_id(paper_id).ok_or_else(invalid_cursor)?;
    if created_at_micros <= 0 {
        return Err(invalid_cursor());
    }
    Ok(PublicationCursor {
        created_at_micros,
        paper_id,
    })
}

fn invalid_cursor() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "request.invalid_cursor",
        "cursor is invalid or malformed",
    )
}

fn authorize(headers: &HeaderMap, expected_token: &str) -> Result<(), ApiError> {
    let provided = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, token)| token);
    let authorized = provided.is_some_and(|token| {
        token.len() == expected_token.len()
            && bool::from(token.as_bytes().ct_eq(expected_token.as_bytes()))
    });
    if authorized {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "auth.unauthorized",
            "a valid bearer token is required",
        ))
    }
}

fn store_error(error: StoreError) -> ApiError {
    match error {
        StoreError::InvalidPublication(report) => ApiError::validation(report),
        StoreError::IdentifierSpaceExhausted => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "publication.identifier_space_exhausted",
            "paper identifier space for the current month is exhausted",
        ),
        StoreError::IdempotencyConflict => ApiError::new(
            StatusCode::CONFLICT,
            "publication.idempotency_conflict",
            "idempotency key was already used for different paper content",
        ),
        StoreError::InvalidProduct => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "product.invalid",
            "product_id must identify an existing prodxiv product",
        ),
        StoreError::InvalidTrendingSnapshot(message) => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "trending.invalid_snapshot",
            format!("GitHub Trending snapshot is invalid: {message}"),
        ),
        StoreError::Internal => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage.internal",
            "publication storage failed",
        ),
    }
}

fn trending_store_error(error: StoreError) -> ApiError {
    match error {
        StoreError::IdempotencyConflict => ApiError::new(
            StatusCode::CONFLICT,
            "trending.idempotency_conflict",
            "idempotency key was reused for different snapshot content",
        ),
        StoreError::InvalidTrendingSnapshot(message) => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "trending.invalid_snapshot",
            format!("GitHub Trending snapshot is invalid: {message}"),
        ),
        StoreError::Internal => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage.internal",
            "GitHub Trending snapshot ingestion failed",
        ),
        other => {
            tracing::error!(error = %other, "unexpected Trending ingestion error");
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "storage.internal",
                "GitHub Trending snapshot ingestion failed",
            )
        }
    }
}

#[derive(OpenApi)]
#[openapi(
    info(
        title = "prodxiv publishing API",
        version = "0.1.0",
        description = "Authoritative immutable publication and retrieval API."
    ),
    paths(
        health,
        list_papers,
        publish_paper,
        get_paper_revision,
        get_github_trending,
        ingest_github_trending_snapshot
    ),
    components(schemas(
        PublishPaperRequest,
        IngestGitHubTrendingRequest,
        IngestGitHubTrendingEntry,
        GitHubTrendingIngestionResponse,
        PublishedPaper,
        PublishedPaperSummary,
        PaperListResponse,
        GitHubTrendingResponse,
        GitHubTrendingSnapshotResponse,
        GitHubTrendingEntryResponse,
        HealthResponse,
        ErrorResponse,
        ErrorBody,
        Diagnostic
    )),
    modifiers(&SecurityAddon)
)]
struct ApiDoc;

struct SecurityAddon;

impl Modify for SecurityAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        if let Some(components) = openapi.components.as_mut() {
            components.add_security_scheme(
                "bearer_token",
                SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
            );
        }
    }
}

pub fn openapi() -> utoipa::openapi::OpenApi {
    ApiDoc::openapi()
}

#[cfg(test)]
mod tests {
    use super::{resolve_bind_address, resolve_migration_database_url};

    #[test]
    fn explicit_bind_address_takes_precedence_over_vercel_port() {
        assert_eq!(
            resolve_bind_address(Some("127.0.0.1:4000"), Some("5000"))
                .expect("explicit address should parse")
                .to_string(),
            "127.0.0.1:4000"
        );
    }

    #[test]
    fn vercel_port_binds_on_all_interfaces() {
        assert_eq!(
            resolve_bind_address(None, Some("5000"))
                .expect("Vercel port should parse")
                .to_string(),
            "0.0.0.0:5000"
        );
    }

    #[test]
    fn neon_unpooled_url_is_a_migration_fallback() {
        assert_eq!(
            resolve_migration_database_url(None, Some("postgres://neon".to_owned()))
                .expect("Neon unpooled URL should be accepted"),
            "postgres://neon"
        );
    }
}
