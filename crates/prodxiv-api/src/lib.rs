//! Authoritative HTTP API for drafting, publishing, and reading prodxiv papers.

use std::{
    env,
    net::{AddrParseError, SocketAddr},
    sync::Arc,
};

use async_trait::async_trait;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State, rejection::JsonRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use prodxiv_domain::{
    DRAFT_REVISION_RETENTION, Diagnostic, DraftOwnerKind, DraftReviewStatus,
    MAX_DRAFT_REJECTION_REASON_BYTES, PaperDocument, PaperDraft, PaperDraftRevision,
    PaperDraftRevisionSummary, PaperDraftSummary, PublishedPaper, PublishedPaperSummary,
    ValidationProfile, ValidationReport, canonicalize_paper_id, validate_paper,
};
use prodxiv_storage::{
    DraftCreateOutcome, DraftUpdateOutcome, GITHUB_TRENDING_ANY_LANGUAGE, GitHubTrendingEntry,
    GitHubTrendingLanguageScope, GitHubTrendingLanguageSelector, GitHubTrendingSnapshot,
    GitHubTrendingView, NewGitHubTrendingEntry, NewGitHubTrendingSnapshot, PostgresStorage,
    PublicationCursor, PublicationPage, PublishOutcome, StorageError, TrendingImportOutcome,
    is_valid_idempotency_key,
};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use thiserror::Error;
use tower_http::trace::TraceLayer;
use utoipa::{
    Modify, OpenApi, ToSchema,
    openapi::security::{Http, HttpAuthScheme, SecurityScheme},
};
const MAX_DRAFT_SOURCE_BYTES: usize = 2 * 1024 * 1024;
// A one-byte control character may occupy six bytes as a JSON `\u00XX` escape.
// Keep a small fixed allowance for the request object's field syntax.
const MAX_DRAFT_WRITE_BODY_BYTES: usize = MAX_DRAFT_SOURCE_BYTES * 6 + 64;
const MAX_DRAFT_REVISION: u32 = i32::MAX as u32;

#[derive(Clone)]
pub struct AppState {
    store: Arc<dyn PublicationStore>,
    publish_token: Arc<str>,
    publish_actor: Arc<str>,
    bot_principal: Option<DraftPrincipal>,
    trending_ingest_token: Option<Arc<str>>,
}

#[derive(Clone)]
struct DraftPrincipal {
    token: Arc<str>,
    actor: Arc<str>,
    owner_kind: DraftOwnerKind,
}

#[derive(Clone, Copy)]
struct AuthorizedDraftPrincipal<'a> {
    actor: &'a str,
    owner_kind: DraftOwnerKind,
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
            bot_principal: None,
            trending_ingest_token: None,
        }
    }

    #[must_use]
    pub fn with_bot_principal(mut self, token: Option<String>, actor: String) -> Self {
        self.bot_principal = token.map(|token| DraftPrincipal {
            token: Arc::from(token),
            actor: Arc::from(actor),
            owner_kind: DraftOwnerKind::Bot,
        });
        self
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
    pub bot_token: Option<String>,
    pub bot_actor: String,
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
        let bot_token = env::var("PRODXIV_BOT_TOKEN")
            .ok()
            .filter(|token| !token.trim().is_empty());
        if bot_token.as_ref().is_some_and(|token| token.len() < 32) {
            return Err(ConfigError::WeakBotToken);
        }
        if bot_token.as_deref() == Some(publish_token.as_str()) {
            return Err(ConfigError::ReusedBotToken);
        }
        let bot_actor =
            env::var("PRODXIV_BOT_ACTOR").unwrap_or_else(|_| "paperbot:daily".to_owned());
        if bot_actor.trim().is_empty() {
            return Err(ConfigError::EmptyBotActor);
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
        if trending_ingest_token.as_deref() == bot_token.as_deref()
            && trending_ingest_token.is_some()
        {
            return Err(ConfigError::ReusedBotToken);
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
            bot_token,
            bot_actor,
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
    #[error("PRODXIV_BOT_TOKEN must contain at least 32 characters")]
    WeakBotToken,
    #[error("PRODXIV_BOT_ACTOR must not be empty")]
    EmptyBotActor,
    #[error("PRODXIV_BOT_TOKEN must differ from other API tokens")]
    ReusedBotToken,
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
    async fn create_draft(
        &self,
        source_markdown: &str,
        actor: &str,
        owner_kind: DraftOwnerKind,
        idempotency_key: &str,
    ) -> Result<DraftCreateOutcome, StoreError>;

    async fn list_drafts(
        &self,
        limit: u32,
        review_status: Option<DraftReviewStatus>,
        owner_kind: Option<DraftOwnerKind>,
    ) -> Result<Vec<PaperDraftSummary>, StoreError>;

    async fn find_draft(&self, paper_uuid: &str) -> Result<Option<PaperDraft>, StoreError>;

    async fn update_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        source_markdown: &str,
        actor: &str,
        actor_kind: DraftOwnerKind,
    ) -> Result<Option<DraftUpdateOutcome>, StoreError>;

    async fn approve_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        actor: &str,
        actor_kind: DraftOwnerKind,
    ) -> Result<Option<PaperDraft>, StoreError>;

    async fn reject_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        actor: &str,
        actor_kind: DraftOwnerKind,
        reason: Option<&str>,
    ) -> Result<Option<PaperDraft>, StoreError>;

    async fn list_draft_revisions(
        &self,
        paper_uuid: &str,
    ) -> Result<Option<Vec<PaperDraftRevisionSummary>>, StoreError>;

    async fn find_draft_revision(
        &self,
        paper_uuid: &str,
        revision: u32,
    ) -> Result<Option<PaperDraftRevision>, StoreError>;

    async fn delete_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        actor: &str,
        actor_kind: DraftOwnerKind,
    ) -> Result<bool, StoreError>;

    async fn publish_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        actor: &str,
        idempotency_key: &str,
        product_id: Option<&str>,
    ) -> Result<Option<PublishOutcome>, StoreError>;

    async fn approve_and_publish_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        actor: &str,
        actor_kind: DraftOwnerKind,
        idempotency_key: &str,
        product_id: Option<&str>,
    ) -> Result<Option<PublishOutcome>, StoreError>;

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
        language: &GitHubTrendingLanguageSelector,
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
    async fn create_draft(
        &self,
        source_markdown: &str,
        actor: &str,
        owner_kind: DraftOwnerKind,
        idempotency_key: &str,
    ) -> Result<DraftCreateOutcome, StoreError> {
        PostgresStorage::create_draft_idempotent(
            self,
            source_markdown,
            actor,
            owner_kind,
            idempotency_key,
        )
        .await
        .map_err(StoreError::from)
    }

    async fn list_drafts(
        &self,
        limit: u32,
        review_status: Option<DraftReviewStatus>,
        owner_kind: Option<DraftOwnerKind>,
    ) -> Result<Vec<PaperDraftSummary>, StoreError> {
        PostgresStorage::list_drafts(self, limit, review_status, owner_kind)
            .await
            .map_err(StoreError::from)
    }

    async fn find_draft(&self, paper_uuid: &str) -> Result<Option<PaperDraft>, StoreError> {
        PostgresStorage::find_draft(self, paper_uuid)
            .await
            .map_err(StoreError::from)
    }

    async fn update_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        source_markdown: &str,
        actor: &str,
        actor_kind: DraftOwnerKind,
    ) -> Result<Option<DraftUpdateOutcome>, StoreError> {
        PostgresStorage::update_draft(
            self,
            paper_uuid,
            expected_revision,
            source_markdown,
            actor,
            actor_kind,
        )
        .await
        .map_err(StoreError::from)
    }

    async fn approve_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        actor: &str,
        actor_kind: DraftOwnerKind,
    ) -> Result<Option<PaperDraft>, StoreError> {
        PostgresStorage::approve_draft(self, paper_uuid, expected_revision, actor, actor_kind)
            .await
            .map_err(StoreError::from)
    }

    async fn reject_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        actor: &str,
        actor_kind: DraftOwnerKind,
        reason: Option<&str>,
    ) -> Result<Option<PaperDraft>, StoreError> {
        PostgresStorage::reject_draft(
            self,
            paper_uuid,
            expected_revision,
            actor,
            actor_kind,
            reason,
        )
        .await
        .map_err(StoreError::from)
    }

    async fn list_draft_revisions(
        &self,
        paper_uuid: &str,
    ) -> Result<Option<Vec<PaperDraftRevisionSummary>>, StoreError> {
        PostgresStorage::list_draft_revisions(self, paper_uuid)
            .await
            .map_err(StoreError::from)
    }

    async fn find_draft_revision(
        &self,
        paper_uuid: &str,
        revision: u32,
    ) -> Result<Option<PaperDraftRevision>, StoreError> {
        PostgresStorage::find_draft_revision(self, paper_uuid, revision)
            .await
            .map_err(StoreError::from)
    }

    async fn delete_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        actor: &str,
        actor_kind: DraftOwnerKind,
    ) -> Result<bool, StoreError> {
        PostgresStorage::delete_draft(self, paper_uuid, expected_revision, actor, actor_kind)
            .await
            .map_err(StoreError::from)
    }

    async fn publish_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        actor: &str,
        idempotency_key: &str,
        product_id: Option<&str>,
    ) -> Result<Option<PublishOutcome>, StoreError> {
        PostgresStorage::publish_draft(
            self,
            paper_uuid,
            expected_revision,
            actor,
            idempotency_key,
            product_id,
        )
        .await
        .map_err(StoreError::from)
    }

    async fn approve_and_publish_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        actor: &str,
        actor_kind: DraftOwnerKind,
        idempotency_key: &str,
        product_id: Option<&str>,
    ) -> Result<Option<PublishOutcome>, StoreError> {
        PostgresStorage::approve_and_publish_draft(
            self,
            paper_uuid,
            expected_revision,
            actor,
            actor_kind,
            idempotency_key,
            product_id,
        )
        .await
        .map_err(StoreError::from)
    }

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
        language: &GitHubTrendingLanguageSelector,
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
    #[error("draft source Markdown is invalid")]
    InvalidDraftSource,
    #[error("draft paper Markdown is invalid: {0}")]
    InvalidDraftMarkdown(String),
    #[error("draft rejection reason is invalid")]
    InvalidDraftRejectionReason,
    #[error("draft changed; current revision is {current_revision}")]
    DraftRevisionConflict { current_revision: u32 },
    #[error("draft revision has not been approved")]
    DraftNotApproved,
    #[error("draft ownership does not permit this operation")]
    DraftOwnerForbidden,
    #[error("draft creation was already completed")]
    DraftCreationCompleted,
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
            | StorageError::CorruptDraftReviewStatus(_)
            | StorageError::CorruptDraftOwnerKind(_)
            | StorageError::TrendingSerialization(_)
            | StorageError::CorruptTrendingRank(_)
            | StorageError::CorruptTrendingLanguageScope(_) => {
                tracing::error!(error = %error, "API storage operation failed");
                Self::Internal
            }
            StorageError::InvalidProductId | StorageError::UnknownProduct(_) => {
                Self::InvalidProduct
            }
            StorageError::InvalidDraftSource => Self::InvalidDraftSource,
            StorageError::InvalidDraftMarkdown(error) => {
                Self::InvalidDraftMarkdown(error.to_string())
            }
            StorageError::InvalidDraftRejectionReason => Self::InvalidDraftRejectionReason,
            StorageError::DraftRevisionConflict { current_revision } => {
                Self::DraftRevisionConflict { current_revision }
            }
            StorageError::DraftNotApproved => Self::DraftNotApproved,
            StorageError::DraftOwnerForbidden => Self::DraftOwnerForbidden,
            StorageError::DraftCreationCompleted => Self::DraftCreationCompleted,
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
pub struct WriteDraftRequest {
    pub source_markdown: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PublishDraftRequest {
    #[serde(default)]
    pub product_id: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RejectDraftRequest {
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct IngestGitHubTrendingRequest {
    pub snapshot_date: String,
    #[serde(default)]
    pub captured_at: Option<String>,
    pub period: String,
    pub language: String,
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

impl TryFrom<IngestGitHubTrendingRequest> for NewGitHubTrendingSnapshot {
    type Error = &'static str;

    fn try_from(snapshot: IngestGitHubTrendingRequest) -> Result<Self, Self::Error> {
        let language = GitHubTrendingLanguageScope::parse(&snapshot.language)
            .ok_or("language must be any or a concrete language slug; all is query-only")?;
        Ok(Self {
            snapshot_date: snapshot.snapshot_date,
            captured_at: snapshot.captured_at,
            period: snapshot.period,
            language,
            spoken_language: snapshot.spoken_language,
            source_kind: snapshot.source_kind,
            source_url: snapshot.source_url,
            source_revision: snapshot.source_revision,
            entries: snapshot.entries.into_iter().map(Into::into).collect(),
        })
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
struct DraftPath {
    paper_uuid: String,
}

#[derive(Debug, Deserialize)]
struct DraftRevisionPath {
    paper_uuid: String,
    revision: u32,
}

#[derive(Debug, Deserialize)]
struct ListPapersQuery {
    limit: Option<u32>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ListDraftsQuery {
    limit: Option<u32>,
    review_status: Option<String>,
    owner_kind: Option<String>,
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
pub struct PaperDraftListResponse {
    pub drafts: Vec<PaperDraftSummary>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PaperDraftRevisionListResponse {
    pub revisions: Vec<PaperDraftRevisionSummary>,
    pub retained_revision_limit: u32,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GitHubTrendingResponse {
    pub requested_language: String,
    pub snapshots: Vec<GitHubTrendingSnapshotResponse>,
    pub previous_date: Option<String>,
    pub next_date: Option<String>,
    pub available_languages: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GitHubTrendingSnapshotResponse {
    pub snapshot_date: String,
    pub captured_at: Option<String>,
    pub period: String,
    pub language: String,
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
            language: snapshot.language.as_str().to_owned(),
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
            "/v1/drafts",
            get(list_drafts)
                .post(create_draft)
                .layer(DefaultBodyLimit::max(MAX_DRAFT_WRITE_BODY_BYTES)),
        )
        .route(
            "/v1/drafts/{paper_uuid}",
            get(get_draft)
                .put(update_draft)
                .delete(delete_draft)
                .layer(DefaultBodyLimit::max(MAX_DRAFT_WRITE_BODY_BYTES)),
        )
        .route(
            "/v1/drafts/{paper_uuid}/revisions",
            get(list_draft_revisions),
        )
        .route(
            "/v1/drafts/{paper_uuid}/revisions/{revision}",
            get(get_draft_revision),
        )
        .route("/v1/drafts/{paper_uuid}/approve", post(approve_draft))
        .route(
            "/v1/drafts/{paper_uuid}/reject",
            post(reject_draft).layer(DefaultBodyLimit::max(
                MAX_DRAFT_REJECTION_REASON_BYTES * 6 + 64,
            )),
        )
        .route("/v1/drafts/{paper_uuid}/publish", post(publish_draft))
        .route(
            "/v1/drafts/{paper_uuid}/approve-and-publish",
            post(approve_and_publish_draft),
        )
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
    let snapshot = NewGitHubTrendingSnapshot::try_from(payload).map_err(|message| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "trending.snapshot_invalid",
            message,
        )
    })?;
    let outcome = state
        .store
        .ingest_github_trending_snapshot(snapshot, actor, idempotency_key)
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
      ("language" = Option<String>, Query, description = "any for the unfiltered scope, all for every stored scope, or a concrete language slug; defaults to any"),
      ("spoken_language" = Option<String>, Query, description = "Exact GitHub Trending spoken-language scope")
    ),
    responses(
      (status = 200, description = "Latest imported snapshots for the requested language selector", body = GitHubTrendingResponse),
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
    let requested_language = normalized_scope(query.language.as_deref())
        .unwrap_or(GITHUB_TRENDING_ANY_LANGUAGE)
        .to_ascii_lowercase();
    let language = GitHubTrendingLanguageSelector::parse(&requested_language).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "request.invalid_trending_language",
            "language must be any, all, or a concrete language slug",
        )
    })?;
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
        .github_trending_view(period, &language, spoken_language, snapshot_date)
        .await
        .map_err(store_error)?;
    Ok(Json(GitHubTrendingResponse {
        requested_language: language.as_str().to_owned(),
        snapshots: view.snapshots.into_iter().map(Into::into).collect(),
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
    post,
    path = "/v1/drafts",
    security(("bearer_token" = [])),
    params(
      ("Idempotency-Key" = String, Header, description = "Stable key for safely retrying this exact draft creation")
    ),
    request_body = WriteDraftRequest,
    responses(
      (status = 201, description = "Mutable draft was created", body = PaperDraft),
      (status = 200, description = "Original mutable draft returned for an idempotent retry", body = PaperDraft),
      (status = 400, description = "JSON is invalid", body = ErrorResponse),
      (status = 401, description = "Bearer token is absent or invalid", body = ErrorResponse),
      (status = 409, description = "Idempotency key conflicts or its draft already completed", body = ErrorResponse),
      (status = 422, description = "Draft source is empty or too large", body = ErrorResponse),
      (status = 500, description = "Draft creation failed", body = ErrorResponse)
    )
)]
async fn create_draft(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<WriteDraftRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let principal = authorize_draft(&headers, &state)?;
    let idempotency_key = idempotency_key(&headers)?;
    let Json(payload) = payload.map_err(invalid_json)?;
    validate_draft_source(&payload.source_markdown)?;
    let outcome = state
        .store
        .create_draft(
            &payload.source_markdown,
            principal.actor,
            principal.owner_kind,
            idempotency_key,
        )
        .await
        .map_err(draft_store_error)?;
    let draft = outcome.draft;
    let location = format!("/v1/drafts/{}", draft.paper_uuid);
    let status = if outcome.replayed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    let mut response = draft_response(status, draft);
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(&location).expect("draft locations contain valid header characters"),
    );
    Ok(response)
}

#[utoipa::path(
    get,
    path = "/v1/drafts",
    security(("bearer_token" = [])),
    params(
      ("limit" = Option<u32>, Query, minimum = 1, maximum = 100, description = "Maximum drafts to return; defaults to 20"),
      ("review_status" = Option<String>, Query, description = "Optional pending_review, approved, or rejected filter"),
      ("owner_kind" = Option<String>, Query, description = "Optional author or bot ownership filter")
    ),
    responses(
      (status = 200, description = "Drafts ordered by most recent edit", body = PaperDraftListResponse),
      (status = 400, description = "Limit is invalid", body = ErrorResponse),
      (status = 401, description = "Bearer token is absent or invalid", body = ErrorResponse),
      (status = 500, description = "Reading drafts failed", body = ErrorResponse)
    )
)]
async fn list_drafts(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListDraftsQuery>,
) -> Result<Json<PaperDraftListResponse>, ApiError> {
    authorize_draft(&headers, &state)?;
    let limit = query.limit.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "request.invalid_limit",
            "limit must be between 1 and 100",
        ));
    }
    let review_status = query
        .review_status
        .as_deref()
        .map(|value| {
            DraftReviewStatus::parse(value).ok_or_else(|| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "draft.invalid_review_status",
                    "review_status must be pending_review, approved, or rejected",
                )
            })
        })
        .transpose()?;
    let owner_kind = query
        .owner_kind
        .as_deref()
        .map(|value| {
            DraftOwnerKind::parse(value).ok_or_else(|| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "draft.invalid_owner_kind",
                    "owner_kind must be author or bot",
                )
            })
        })
        .transpose()?;
    let drafts = state
        .store
        .list_drafts(limit, review_status, owner_kind)
        .await
        .map_err(draft_store_error)?;
    Ok(Json(PaperDraftListResponse { drafts }))
}

#[utoipa::path(
    get,
    path = "/v1/drafts/{paper_uuid}",
    security(("bearer_token" = [])),
    params(("paper_uuid" = String, Path, description = "Unpublished paper UUID")),
    responses(
      (status = 200, description = "Current mutable draft snapshot", body = PaperDraft),
      (status = 400, description = "Paper UUID is invalid", body = ErrorResponse),
      (status = 401, description = "Bearer token is absent or invalid", body = ErrorResponse),
      (status = 404, description = "Draft does not exist", body = ErrorResponse),
      (status = 500, description = "Reading the draft failed", body = ErrorResponse)
    )
)]
async fn get_draft(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(path): Path<DraftPath>,
) -> Result<Response, ApiError> {
    authorize_draft(&headers, &state)?;
    let paper_uuid = canonical_draft_uuid(&path.paper_uuid)?;
    let draft = state
        .store
        .find_draft(&paper_uuid)
        .await
        .map_err(draft_store_error)?
        .ok_or_else(draft_not_found)?;
    Ok(draft_response(StatusCode::OK, draft))
}

#[utoipa::path(
    put,
    path = "/v1/drafts/{paper_uuid}",
    security(("bearer_token" = [])),
    params(
      ("paper_uuid" = String, Path, description = "Unpublished paper UUID"),
      ("If-Match" = String, Header, description = "Quoted current draft revision, for example \"3\"")
    ),
    request_body = WriteDraftRequest,
    responses(
      (status = 200, description = "Next mutable draft snapshot", body = PaperDraft),
      (status = 400, description = "Request, paper UUID, or If-Match is invalid", body = ErrorResponse),
      (status = 401, description = "Bearer token is absent or invalid", body = ErrorResponse),
      (status = 403, description = "Bot principal attempted to edit an author-owned draft", body = ErrorResponse),
      (status = 404, description = "Draft does not exist", body = ErrorResponse),
      (status = 409, description = "Draft changed since the caller read it", body = ErrorResponse),
      (status = 422, description = "Draft source is empty or too large", body = ErrorResponse),
      (status = 428, description = "If-Match is required", body = ErrorResponse),
      (status = 500, description = "Updating the draft failed", body = ErrorResponse)
    )
)]
async fn update_draft(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(path): Path<DraftPath>,
    payload: Result<Json<WriteDraftRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let principal = authorize_draft(&headers, &state)?;
    let paper_uuid = canonical_draft_uuid(&path.paper_uuid)?;
    let expected_revision = expected_draft_revision(&headers)?;
    let Json(payload) = payload.map_err(invalid_json)?;
    validate_draft_source(&payload.source_markdown)?;
    let outcome = state
        .store
        .update_draft(
            &paper_uuid,
            expected_revision,
            &payload.source_markdown,
            principal.actor,
            principal.owner_kind,
        )
        .await
        .map_err(draft_store_error)?
        .ok_or_else(draft_not_found)?;
    Ok(draft_response(StatusCode::OK, outcome.draft))
}

#[utoipa::path(
    post,
    path = "/v1/drafts/{paper_uuid}/approve",
    security(("bearer_token" = [])),
    params(
      ("paper_uuid" = String, Path, description = "Unpublished paper UUID"),
      ("If-Match" = String, Header, description = "Quoted current draft revision, for example \"3\"")
    ),
    responses(
      (status = 200, description = "Exact current revision was approved for a later publication run", body = PaperDraft),
      (status = 400, description = "Paper UUID or If-Match is invalid", body = ErrorResponse),
      (status = 401, description = "Bearer token is absent or invalid", body = ErrorResponse),
      (status = 403, description = "Bot principals cannot approve through the author review endpoint", body = ErrorResponse),
      (status = 404, description = "Draft does not exist", body = ErrorResponse),
      (status = 409, description = "Draft changed since the caller read it", body = ErrorResponse),
      (status = 422, description = "Draft is not valid for publication", body = ErrorResponse),
      (status = 428, description = "If-Match is required", body = ErrorResponse),
      (status = 500, description = "Approving the draft failed", body = ErrorResponse)
    )
)]
async fn approve_draft(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(path): Path<DraftPath>,
) -> Result<Response, ApiError> {
    let principal = authorize_draft(&headers, &state)?;
    let paper_uuid = canonical_draft_uuid(&path.paper_uuid)?;
    let expected_revision = expected_draft_revision(&headers)?;
    let draft = state
        .store
        .approve_draft(
            &paper_uuid,
            expected_revision,
            principal.actor,
            principal.owner_kind,
        )
        .await
        .map_err(review_draft_store_error)?
        .ok_or_else(draft_not_found)?;
    Ok(draft_response(StatusCode::OK, draft))
}

#[utoipa::path(
    post,
    path = "/v1/drafts/{paper_uuid}/reject",
    security(("bearer_token" = [])),
    params(
      ("paper_uuid" = String, Path, description = "Unpublished paper UUID"),
      ("If-Match" = String, Header, description = "Quoted current draft revision, for example \"3\"")
    ),
    request_body = RejectDraftRequest,
    responses(
      (status = 200, description = "Exact current revision was rejected and retained", body = PaperDraft),
      (status = 400, description = "Request, paper UUID, or If-Match is invalid", body = ErrorResponse),
      (status = 401, description = "Bearer token is absent or invalid", body = ErrorResponse),
      (status = 403, description = "Bot principal attempted to reject an author-owned draft", body = ErrorResponse),
      (status = 404, description = "Draft does not exist", body = ErrorResponse),
      (status = 409, description = "Draft changed since the caller read it", body = ErrorResponse),
      (status = 422, description = "Rejection reason is too large", body = ErrorResponse),
      (status = 428, description = "If-Match is required", body = ErrorResponse),
      (status = 500, description = "Rejecting the draft failed", body = ErrorResponse)
    )
)]
async fn reject_draft(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(path): Path<DraftPath>,
    payload: Result<Json<RejectDraftRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let principal = authorize_draft(&headers, &state)?;
    let paper_uuid = canonical_draft_uuid(&path.paper_uuid)?;
    let expected_revision = expected_draft_revision(&headers)?;
    let Json(payload) = payload.map_err(invalid_json)?;
    if payload
        .reason
        .as_ref()
        .is_some_and(|reason| reason.len() > MAX_DRAFT_REJECTION_REASON_BYTES)
    {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "draft.rejection_reason_too_large",
            format!("reason must not exceed {MAX_DRAFT_REJECTION_REASON_BYTES} UTF-8 bytes"),
        ));
    }
    let draft = state
        .store
        .reject_draft(
            &paper_uuid,
            expected_revision,
            principal.actor,
            principal.owner_kind,
            payload.reason.as_deref(),
        )
        .await
        .map_err(review_draft_store_error)?
        .ok_or_else(draft_not_found)?;
    Ok(draft_response(StatusCode::OK, draft))
}

#[utoipa::path(
    delete,
    path = "/v1/drafts/{paper_uuid}",
    security(("bearer_token" = [])),
    params(
      ("paper_uuid" = String, Path, description = "Unpublished paper UUID"),
      ("If-Match" = String, Header, description = "Quoted current draft revision, for example \"3\"")
    ),
    responses(
      (status = 204, description = "Draft content and retained snapshots were deleted"),
      (status = 400, description = "Paper UUID or If-Match is invalid", body = ErrorResponse),
      (status = 401, description = "Bearer token is absent or invalid", body = ErrorResponse),
      (status = 403, description = "Bot principal attempted to delete an author-owned draft", body = ErrorResponse),
      (status = 404, description = "Draft does not exist", body = ErrorResponse),
      (status = 409, description = "Draft changed since the caller read it", body = ErrorResponse),
      (status = 428, description = "If-Match is required", body = ErrorResponse),
      (status = 500, description = "Deleting the draft failed", body = ErrorResponse)
    )
)]
async fn delete_draft(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(path): Path<DraftPath>,
) -> Result<StatusCode, ApiError> {
    let principal = authorize_draft(&headers, &state)?;
    let paper_uuid = canonical_draft_uuid(&path.paper_uuid)?;
    let expected_revision = expected_draft_revision(&headers)?;
    let deleted = state
        .store
        .delete_draft(
            &paper_uuid,
            expected_revision,
            principal.actor,
            principal.owner_kind,
        )
        .await
        .map_err(draft_store_error)?;
    if !deleted {
        return Err(draft_not_found());
    }
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/v1/drafts/{paper_uuid}/revisions",
    security(("bearer_token" = [])),
    params(("paper_uuid" = String, Path, description = "Unpublished paper UUID")),
    responses(
      (status = 200, description = "Up to five retained draft snapshots, newest first", body = PaperDraftRevisionListResponse),
      (status = 400, description = "Paper UUID is invalid", body = ErrorResponse),
      (status = 401, description = "Bearer token is absent or invalid", body = ErrorResponse),
      (status = 404, description = "Draft does not exist", body = ErrorResponse),
      (status = 500, description = "Reading draft revisions failed", body = ErrorResponse)
    )
)]
async fn list_draft_revisions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(path): Path<DraftPath>,
) -> Result<Json<PaperDraftRevisionListResponse>, ApiError> {
    authorize_draft(&headers, &state)?;
    let paper_uuid = canonical_draft_uuid(&path.paper_uuid)?;
    let revisions = state
        .store
        .list_draft_revisions(&paper_uuid)
        .await
        .map_err(draft_store_error)?
        .ok_or_else(draft_not_found)?;
    Ok(Json(PaperDraftRevisionListResponse {
        revisions,
        retained_revision_limit: DRAFT_REVISION_RETENTION,
    }))
}

#[utoipa::path(
    get,
    path = "/v1/drafts/{paper_uuid}/revisions/{revision}",
    security(("bearer_token" = [])),
    params(
      ("paper_uuid" = String, Path, description = "Unpublished paper UUID"),
      ("revision" = u32, Path, minimum = 1)
    ),
    responses(
      (status = 200, description = "Exact retained draft snapshot", body = PaperDraftRevision),
      (status = 400, description = "Paper UUID or revision is invalid", body = ErrorResponse),
      (status = 401, description = "Bearer token is absent or invalid", body = ErrorResponse),
      (status = 404, description = "Draft revision is not retained", body = ErrorResponse),
      (status = 500, description = "Reading the draft revision failed", body = ErrorResponse)
    )
)]
async fn get_draft_revision(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(path): Path<DraftRevisionPath>,
) -> Result<Json<PaperDraftRevision>, ApiError> {
    authorize_draft(&headers, &state)?;
    let paper_uuid = canonical_draft_uuid(&path.paper_uuid)?;
    if !(1..=MAX_DRAFT_REVISION).contains(&path.revision) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "draft.invalid_revision",
            "draft revision must be a positive 32-bit integer",
        ));
    }
    let revision = state
        .store
        .find_draft_revision(&paper_uuid, path.revision)
        .await
        .map_err(draft_store_error)?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "draft.revision_not_found",
                "draft revision does not exist or is no longer retained",
            )
        })?;
    Ok(Json(revision))
}

#[utoipa::path(
    post,
    path = "/v1/drafts/{paper_uuid}/publish",
    security(("bearer_token" = [])),
    params(
      ("paper_uuid" = String, Path, description = "Unpublished paper UUID"),
      ("If-Match" = String, Header, description = "Quoted current draft revision, for example \"3\""),
      ("Idempotency-Key" = String, Header, description = "Stable key for safely retrying this exact draft publication")
    ),
    request_body = PublishDraftRequest,
    responses(
      (status = 201, description = "Exact draft revision was published and mutable content was removed", body = PublishedPaper),
      (status = 200, description = "Original publication returned for an idempotent retry", body = PublishedPaper),
      (status = 400, description = "Request, paper UUID, If-Match, or idempotency key is invalid", body = ErrorResponse),
      (status = 401, description = "Bearer token is absent or invalid", body = ErrorResponse),
      (status = 404, description = "Draft does not exist", body = ErrorResponse),
      (status = 409, description = "Draft changed or the idempotency key conflicts", body = ErrorResponse),
      (status = 422, description = "Draft Markdown or requested product is not publishable", body = ErrorResponse),
      (status = 428, description = "If-Match is required", body = ErrorResponse),
      (status = 500, description = "Publishing failed", body = ErrorResponse),
      (status = 503, description = "Monthly identifier space is exhausted", body = ErrorResponse)
    )
)]
async fn publish_draft(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(path): Path<DraftPath>,
    payload: Result<Json<PublishDraftRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let principal = authorize_draft(&headers, &state)?;
    let paper_uuid = canonical_draft_uuid(&path.paper_uuid)?;
    let expected_revision = expected_draft_revision(&headers)?;
    let idempotency_key = idempotency_key(&headers)?;
    let Json(payload) = payload.map_err(invalid_json)?;
    let outcome = state
        .store
        .publish_draft(
            &paper_uuid,
            expected_revision,
            principal.actor,
            idempotency_key,
            payload.product_id.as_deref(),
        )
        .await
        .map_err(publish_draft_store_error)?
        .ok_or_else(draft_not_found)?;
    Ok(publication_response(outcome))
}

#[utoipa::path(
    post,
    path = "/v1/drafts/{paper_uuid}/approve-and-publish",
    security(("bearer_token" = [])),
    params(
      ("paper_uuid" = String, Path, description = "Unpublished paper UUID"),
      ("If-Match" = String, Header, description = "Quoted current draft revision, for example \"3\""),
      ("Idempotency-Key" = String, Header, description = "Stable key for safely retrying this exact approval and publication")
    ),
    request_body = PublishDraftRequest,
    responses(
      (status = 201, description = "Exact draft revision was approved and published atomically", body = PublishedPaper),
      (status = 200, description = "Original publication returned for an idempotent retry", body = PublishedPaper),
      (status = 400, description = "Request, paper UUID, If-Match, or idempotency key is invalid", body = ErrorResponse),
      (status = 401, description = "Bearer token is absent or invalid", body = ErrorResponse),
      (status = 403, description = "Bot principal attempted to approve a non-pending or author-owned draft", body = ErrorResponse),
      (status = 404, description = "Draft does not exist", body = ErrorResponse),
      (status = 409, description = "Draft changed or the idempotency key conflicts", body = ErrorResponse),
      (status = 422, description = "Draft Markdown or requested product is not publishable", body = ErrorResponse),
      (status = 428, description = "If-Match is required", body = ErrorResponse),
      (status = 500, description = "Approving and publishing failed", body = ErrorResponse),
      (status = 503, description = "Monthly identifier space is exhausted", body = ErrorResponse)
    )
)]
async fn approve_and_publish_draft(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(path): Path<DraftPath>,
    payload: Result<Json<PublishDraftRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let principal = authorize_draft(&headers, &state)?;
    let paper_uuid = canonical_draft_uuid(&path.paper_uuid)?;
    let expected_revision = expected_draft_revision(&headers)?;
    let idempotency_key = idempotency_key(&headers)?;
    let Json(payload) = payload.map_err(invalid_json)?;
    let outcome = state
        .store
        .approve_and_publish_draft(
            &paper_uuid,
            expected_revision,
            principal.actor,
            principal.owner_kind,
            idempotency_key,
            payload.product_id.as_deref(),
        )
        .await
        .map_err(publish_draft_store_error)?
        .ok_or_else(draft_not_found)?;
    Ok(publication_response(outcome))
}

fn invalid_json(error: JsonRejection) -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "request.invalid_json",
        error.body_text(),
    )
}

fn validate_draft_source(source_markdown: &str) -> Result<(), ApiError> {
    if source_markdown.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "draft.source_required",
            "source_markdown must not be empty",
        ));
    }
    if source_markdown.len() > MAX_DRAFT_SOURCE_BYTES {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "draft.source_too_large",
            format!("source_markdown must not exceed {MAX_DRAFT_SOURCE_BYTES} bytes"),
        ));
    }
    Ok(())
}

fn canonical_draft_uuid(value: &str) -> Result<String, ApiError> {
    let valid = value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        });
    if valid {
        Ok(value.to_ascii_lowercase())
    } else {
        Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "draft.invalid_uuid",
            "paper_uuid must be a canonical hyphenated UUID",
        ))
    }
}

fn expected_draft_revision(headers: &HeaderMap) -> Result<u32, ApiError> {
    let value = headers.get(header::IF_MATCH).ok_or_else(|| {
        ApiError::new(
            StatusCode::PRECONDITION_REQUIRED,
            "draft.if_match_required",
            "If-Match with the current quoted draft revision is required",
        )
    })?;
    let value = value.to_str().ok().and_then(|value| {
        value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
    });
    let revision = value.and_then(|value| value.parse::<u32>().ok());
    revision
        .filter(|revision| (1..=MAX_DRAFT_REVISION).contains(revision))
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "draft.invalid_if_match",
                "If-Match must contain a positive quoted 32-bit draft revision such as \"3\"",
            )
        })
}

fn draft_response(status: StatusCode, draft: PaperDraft) -> Response {
    let etag = format!("\"{}\"", draft.revision);
    let mut response = (status, Json(draft)).into_response();
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&etag).expect("numeric draft revisions form valid ETags"),
    );
    response
}

fn draft_not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "draft.not_found",
        "draft does not exist",
    )
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
    Ok(publication_response(outcome))
}

fn publication_response(outcome: PublishOutcome) -> Response {
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
    response
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
    let provided = bearer_token(headers);
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

fn authorize_draft<'a>(
    headers: &HeaderMap,
    state: &'a AppState,
) -> Result<AuthorizedDraftPrincipal<'a>, ApiError> {
    let provided = bearer_token(headers);
    let is_author =
        provided.is_some_and(|token| constant_time_token_eq(token, &state.publish_token));
    let is_bot = state.bot_principal.as_ref().is_some_and(|principal| {
        provided.is_some_and(|token| constant_time_token_eq(token, &principal.token))
    });
    if is_author {
        return Ok(AuthorizedDraftPrincipal {
            actor: &state.publish_actor,
            owner_kind: DraftOwnerKind::Author,
        });
    }
    if is_bot {
        let principal = state
            .bot_principal
            .as_ref()
            .expect("a matching bot token has a configured principal");
        return Ok(AuthorizedDraftPrincipal {
            actor: &principal.actor,
            owner_kind: principal.owner_kind,
        });
    }
    Err(ApiError::new(
        StatusCode::UNAUTHORIZED,
        "auth.unauthorized",
        "a valid bearer token is required",
    ))
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, token)| token)
}

fn constant_time_token_eq(provided: &str, expected: &str) -> bool {
    provided.len() == expected.len() && bool::from(provided.as_bytes().ct_eq(expected.as_bytes()))
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
        StoreError::DraftOwnerForbidden => ApiError::new(
            StatusCode::FORBIDDEN,
            "draft.owner_forbidden",
            "the authenticated principal cannot perform this operation for this draft",
        ),
        StoreError::InvalidDraftSource
        | StoreError::InvalidDraftMarkdown(_)
        | StoreError::InvalidDraftRejectionReason
        | StoreError::DraftRevisionConflict { .. }
        | StoreError::DraftNotApproved
        | StoreError::DraftCreationCompleted => {
            tracing::error!(error = %error, "unexpected draft error during publication operation");
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "storage.internal",
                "publication storage failed",
            )
        }
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

fn publish_draft_store_error(error: StoreError) -> ApiError {
    match error {
        StoreError::InvalidDraftMarkdown(message) => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "paper.invalid_markdown",
            message,
        ),
        StoreError::InvalidDraftSource => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "draft.source_required",
            "source_markdown must not be empty",
        ),
        StoreError::DraftRevisionConflict { current_revision } => ApiError::new(
            StatusCode::CONFLICT,
            "draft.revision_conflict",
            format!("draft changed; current revision is {current_revision}"),
        ),
        StoreError::DraftOwnerForbidden => ApiError::new(
            StatusCode::FORBIDDEN,
            "draft.owner_forbidden",
            "the authenticated principal cannot perform this operation for this draft",
        ),
        StoreError::DraftNotApproved => ApiError::new(
            StatusCode::CONFLICT,
            "draft.not_approved",
            "the current draft revision must be approved before publication",
        ),
        other => store_error(other),
    }
}

fn review_draft_store_error(error: StoreError) -> ApiError {
    match error {
        StoreError::InvalidPublication(report) => ApiError::validation(report),
        StoreError::InvalidDraftMarkdown(message) => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "paper.invalid_markdown",
            message,
        ),
        StoreError::InvalidDraftRejectionReason => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "draft.rejection_reason_too_large",
            format!("reason must not exceed {MAX_DRAFT_REJECTION_REASON_BYTES} UTF-8 bytes"),
        ),
        StoreError::DraftRevisionConflict { current_revision } => ApiError::new(
            StatusCode::CONFLICT,
            "draft.revision_conflict",
            format!("draft changed; current revision is {current_revision}"),
        ),
        StoreError::DraftOwnerForbidden => ApiError::new(
            StatusCode::FORBIDDEN,
            "draft.owner_forbidden",
            "the authenticated principal cannot perform this operation for this draft",
        ),
        other => draft_store_error(other),
    }
}

fn draft_store_error(error: StoreError) -> ApiError {
    match error {
        StoreError::InvalidDraftSource => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "draft.source_required",
            "source_markdown must not be empty",
        ),
        StoreError::DraftRevisionConflict { current_revision } => ApiError::new(
            StatusCode::CONFLICT,
            "draft.revision_conflict",
            format!("draft changed; current revision is {current_revision}"),
        ),
        StoreError::DraftOwnerForbidden => ApiError::new(
            StatusCode::FORBIDDEN,
            "draft.owner_forbidden",
            "the authenticated principal cannot perform this operation for this draft",
        ),
        StoreError::InvalidDraftRejectionReason => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "draft.rejection_reason_too_large",
            format!("reason must not exceed {MAX_DRAFT_REJECTION_REASON_BYTES} UTF-8 bytes"),
        ),
        StoreError::IdempotencyConflict => ApiError::new(
            StatusCode::CONFLICT,
            "draft.idempotency_conflict",
            "idempotency key was already used for different draft content",
        ),
        StoreError::DraftCreationCompleted => ApiError::new(
            StatusCode::CONFLICT,
            "draft.creation_completed",
            "the idempotent draft creation already completed and is no longer mutable",
        ),
        StoreError::Internal => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage.internal",
            "draft storage failed",
        ),
        other => {
            tracing::error!(error = %other, "unexpected draft storage error");
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "storage.internal",
                "draft storage failed",
            )
        }
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
        description = "Authoritative private drafting, immutable publication, and retrieval API."
    ),
    paths(
        health,
        create_draft,
        list_drafts,
        get_draft,
        update_draft,
        approve_draft,
        reject_draft,
        delete_draft,
        list_draft_revisions,
        get_draft_revision,
        publish_draft,
        approve_and_publish_draft,
        list_papers,
        publish_paper,
        get_paper_revision,
        get_github_trending,
        ingest_github_trending_snapshot
    ),
    components(schemas(
        WriteDraftRequest,
        PublishDraftRequest,
        RejectDraftRequest,
        DraftOwnerKind,
        DraftReviewStatus,
        PaperDraft,
        PaperDraftSummary,
        PaperDraftListResponse,
        PaperDraftRevision,
        PaperDraftRevisionSummary,
        PaperDraftRevisionListResponse,
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
