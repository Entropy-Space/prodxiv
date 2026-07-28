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
    routing::get,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use prodxiv_domain::{
    Diagnostic, PaperDocument, PublishedPaper, PublishedPaperSummary, ValidationProfile,
    ValidationReport, canonicalize_paper_id, validate_paper,
};
use prodxiv_storage::{
    PostgresStorage, PublicationCursor, PublicationPage, PublishOutcome, StorageError,
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

#[derive(Clone)]
pub struct AppState {
    store: Arc<dyn PublicationStore>,
    publish_token: Arc<str>,
    publish_actor: Arc<str>,
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
        }
    }
}

#[derive(Debug, Clone)]
pub struct ApiConfig {
    pub bind_address: SocketAddr,
    pub database_url: String,
    pub migration_database_url: String,
    pub publish_token: String,
    pub publish_actor: String,
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
    ) -> Result<PublishOutcome, StoreError>;

    async fn find_version(
        &self,
        paper_id: &str,
        version: u32,
    ) -> Result<Option<PublishedPaper>, StoreError>;

    async fn list_latest(
        &self,
        limit: u32,
        cursor: Option<&PublicationCursor>,
    ) -> Result<PublicationPage, StoreError>;
}

#[async_trait]
impl PublicationStore for PostgresStorage {
    async fn publish_new(
        &self,
        paper: PaperDocument,
        submitted_markdown: &str,
        actor: &str,
        idempotency_key: &str,
    ) -> Result<PublishOutcome, StoreError> {
        PostgresStorage::publish_new(self, paper, submitted_markdown, actor, idempotency_key)
            .await
            .map_err(StoreError::from)
    }

    async fn find_version(
        &self,
        paper_id: &str,
        version: u32,
    ) -> Result<Option<PublishedPaper>, StoreError> {
        PostgresStorage::find_version(self, paper_id, version)
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
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("finalized publication is invalid")]
    InvalidPublication(ValidationReport),
    #[error("paper identifier space for the current month is exhausted")]
    IdentifierSpaceExhausted,
    #[error("idempotency key was already used for different content")]
    IdempotencyConflict,
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
            | StorageError::CorruptVersion(_) => {
                tracing::error!(error = %error, "publication storage operation failed");
                Self::Internal
            }
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PublishPaperRequest {
    pub source_markdown: String,
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
struct VersionPath {
    paper_id: String,
    version: u32,
}

#[derive(Debug, Deserialize)]
struct ListPapersQuery {
    limit: Option<u32>,
    cursor: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PaperListResponse {
    pub papers: Vec<PublishedPaperSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/papers", get(list_papers).post(publish_paper))
        .route(
            "/v1/papers/{paper_id}/versions/{version}",
            get(get_paper_version),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state)
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
      (status = 200, description = "Latest published paper versions", body = PaperListResponse),
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
        )
        .await
        .map_err(store_error)?;
    let published = outcome.paper;
    let location = format!(
        "/v1/papers/{}/versions/{}",
        published.paper_id, published.version
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

#[utoipa::path(
    get,
    path = "/v1/papers/{paper_id}/versions/{version}",
    params(
        ("paper_id" = String, Path, description = "Canonical prodxiv paper identifier"),
        ("version" = u32, Path, minimum = 1)
    ),
    responses(
        (status = 200, description = "Exact immutable paper version", body = PublishedPaper),
        (status = 400, description = "Paper identifier or version is invalid", body = ErrorResponse),
        (status = 404, description = "Paper version does not exist", body = ErrorResponse),
        (status = 500, description = "Reading failed", body = ErrorResponse)
    )
)]
async fn get_paper_version(
    State(state): State<AppState>,
    Path(path): Path<VersionPath>,
) -> Result<Json<PublishedPaper>, ApiError> {
    let paper_id = canonicalize_paper_id(&path.paper_id).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "paper.invalid_id",
            "paper identifier must match prodxiv:YYMM.XXXXXX using Crockford Base32",
        )
    })?;
    if path.version == 0 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "paper.invalid_version",
            "paper version must be positive",
        ));
    }

    let published = state
        .store
        .find_version(&paper_id, path.version)
        .await
        .map_err(store_error)?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "paper.not_found",
                "paper version does not exist",
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
        StoreError::Internal => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage.internal",
            "publication storage failed",
        ),
    }
}

#[derive(OpenApi)]
#[openapi(
    info(
        title = "prodxiv publishing API",
        version = "0.1.0",
        description = "Authoritative immutable publication and retrieval API."
    ),
    paths(health, list_papers, publish_paper, get_paper_version),
    components(schemas(
        PublishPaperRequest,
        PublishedPaper,
        PublishedPaperSummary,
        PaperListResponse,
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
