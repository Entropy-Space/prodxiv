//! Authoritative HTTP API for publishing and reading prodxiv papers.

use std::{
    env,
    net::{AddrParseError, SocketAddr},
    sync::Arc,
};

use async_trait::async_trait;
use axum::{
    Json, Router,
    extract::{Path, State, rejection::JsonRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use prodxiv_domain::{
    Diagnostic, PaperDocument, PublishedPaper, ValidationProfile, ValidationReport,
    canonicalize_paper_id, validate_paper,
};
use prodxiv_storage::{PostgresStorage, StorageError};
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
    pub direct_database_url: String,
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
        let direct_database_url = env::var("DIRECT_DATABASE_URL")
            .map_err(|_| ConfigError::Missing("DIRECT_DATABASE_URL"))?;
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
        let bind_address = env::var("PRODXIV_BIND_ADDRESS")
            .unwrap_or_else(|_| "0.0.0.0:3000".to_owned())
            .parse()?;

        Ok(Self {
            bind_address,
            database_url,
            direct_database_url,
            publish_token,
            publish_actor,
        })
    }
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

#[async_trait]
pub trait PublicationStore: Send + Sync {
    async fn publish_new(
        &self,
        paper: PaperDocument,
        submitted_markdown: &str,
        actor: &str,
    ) -> Result<PublishedPaper, StoreError>;

    async fn find_version(
        &self,
        paper_id: &str,
        version: u32,
    ) -> Result<Option<PublishedPaper>, StoreError>;
}

#[async_trait]
impl PublicationStore for PostgresStorage {
    async fn publish_new(
        &self,
        paper: PaperDocument,
        submitted_markdown: &str,
        actor: &str,
    ) -> Result<PublishedPaper, StoreError> {
        PostgresStorage::publish_new(self, paper, submitted_markdown, actor)
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
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("finalized publication is invalid")]
    InvalidPublication(ValidationReport),
    #[error("paper identifier space for the current month is exhausted")]
    IdentifierSpaceExhausted,
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
            StorageError::Database(_)
            | StorageError::Migration(_)
            | StorageError::Publication(prodxiv_domain::PublicationPreparationError::Serialize(
                _,
            ))
            | StorageError::InvalidActor
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

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/papers", post(publish_paper))
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
    post,
    path = "/v1/papers",
    security(("bearer_token" = [])),
    request_body = PublishPaperRequest,
    responses(
        (status = 201, description = "Paper was published", body = PublishedPaper),
        (status = 401, description = "Bearer token is absent or invalid", body = ErrorResponse),
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

    let published = state
        .store
        .publish_new(paper, &payload.source_markdown, &state.publish_actor)
        .await
        .map_err(store_error)?;
    let location = format!(
        "/v1/papers/{}/versions/{}",
        published.paper_id, published.version
    );
    let mut response = (StatusCode::CREATED, Json(published)).into_response();
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(&location).expect("paper locations contain valid header characters"),
    );
    Ok(response)
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
    paths(health, publish_paper, get_paper_version),
    components(schemas(
        PublishPaperRequest,
        PublishedPaper,
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
