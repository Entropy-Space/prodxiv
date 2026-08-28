use axum::{
    Json,
    extract::{Path, Query, State, rejection::QueryRejection},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use prodxiv_domain::{
    PublicPaperDraftResponse, PublicPaperDraftSummary, PublishedPaperSummary, canonicalize_paper_id,
};
use prodxiv_storage::{PublicDraftCursor, PublicationFilter};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    ApiError, AppState, DraftPath, ErrorResponse, canonical_draft_uuid, draft_not_found,
    invalid_cursor, store_error,
};

#[derive(Debug, Deserialize)]
pub(super) struct PublicDraftsQuery {
    limit: Option<u32>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct PaperPath {
    paper_id: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PublicPaperDraftListResponse {
    pub drafts: Vec<PublicPaperDraftSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PaperTopicsResponse {
    pub topics: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PaperRevisionListResponse {
    pub revisions: Vec<PublishedPaperSummary>,
}

pub(super) fn public_drafts_enabled(value: Option<&str>) -> bool {
    value == Some("true")
}

fn require_public_drafts(state: &AppState) -> Result<(), ApiError> {
    if state.public_drafts_enabled {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "draft.public_reads_disabled",
            "public draft reading is not enabled on this deployment",
        ))
    }
}

fn no_store(response: impl IntoResponse) -> Response {
    let mut response = response.into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[utoipa::path(
    get,
    path = "/v1/public/drafts",
    params(
        ("limit" = Option<u32>, Query, minimum = 1, maximum = 100, description = "Maximum current pending drafts; defaults to 20"),
        ("cursor" = Option<String>, Query, description = "Opaque edit-order cursor returned by the previous page")
    ),
    responses(
        (status = 200, description = "Public current pending drafts, most recently edited first; never cache", body = PublicPaperDraftListResponse),
        (status = 400, description = "Pagination parameters are invalid", body = ErrorResponse),
        (status = 500, description = "Reading failed", body = ErrorResponse),
        (status = 503, description = "Public draft reads require deployment opt-in", body = ErrorResponse)
    )
)]
pub(super) async fn list_public_drafts(
    State(state): State<AppState>,
    query: Result<Query<PublicDraftsQuery>, QueryRejection>,
) -> Response {
    no_store(list_public_drafts_result(&state, query).await)
}

async fn list_public_drafts_result(
    state: &AppState,
    query: Result<Query<PublicDraftsQuery>, QueryRejection>,
) -> Result<Json<PublicPaperDraftListResponse>, ApiError> {
    require_public_drafts(state)?;
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "request.invalid_query",
            "draft pagination parameters are invalid",
        )
    })?;
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
        .map(decode_draft_cursor)
        .transpose()?;
    let page = state
        .store
        .list_public_drafts(limit, cursor.as_ref())
        .await
        .map_err(store_error)?;
    Ok(Json(PublicPaperDraftListResponse {
        drafts: page.drafts,
        next_cursor: page.next_cursor.as_ref().map(encode_draft_cursor),
    }))
}

#[utoipa::path(
    get,
    path = "/v1/public/drafts/{paper_uuid}",
    params(("paper_uuid" = String, Path, description = "Unpublished paper UUID, or UUID of a draft promoted to a publication")),
    responses(
        (status = 200, description = "Current pending draft or its exact promoted publication identity; never cache", body = PublicPaperDraftResponse),
        (status = 404, description = "No public pending draft or publication mapping exists", body = ErrorResponse),
        (status = 500, description = "Reading failed", body = ErrorResponse),
        (status = 503, description = "Public draft reads require deployment opt-in", body = ErrorResponse)
    )
)]
pub(super) async fn get_public_draft(
    State(state): State<AppState>,
    Path(path): Path<DraftPath>,
) -> Response {
    no_store(get_public_draft_result(&state, &path.paper_uuid).await)
}

async fn get_public_draft_result(
    state: &AppState,
    paper_uuid: &str,
) -> Result<Json<PublicPaperDraftResponse>, ApiError> {
    require_public_drafts(state)?;
    let paper_uuid = canonical_draft_uuid(paper_uuid).map_err(|_| draft_not_found())?;
    let draft = state
        .store
        .find_public_draft(&paper_uuid)
        .await
        .map_err(store_error)?
        .ok_or_else(draft_not_found)?;
    Ok(Json(draft))
}

#[utoipa::path(
    get,
    path = "/v1/papers/topics",
    responses(
        (status = 200, description = "Sorted unique topics in current published revisions", body = PaperTopicsResponse),
        (status = 500, description = "Reading failed", body = ErrorResponse)
    )
)]
pub(super) async fn list_paper_topics(
    State(state): State<AppState>,
) -> Result<Json<PaperTopicsResponse>, ApiError> {
    let topics = state.store.list_paper_topics().await.map_err(store_error)?;
    Ok(Json(PaperTopicsResponse { topics }))
}

#[utoipa::path(
    get,
    path = "/v1/papers/{paper_id}/revisions",
    params(("paper_id" = String, Path, description = "Canonical prodxiv paper identifier")),
    responses(
        (status = 200, description = "Actual immutable revision summaries, newest first", body = PaperRevisionListResponse),
        (status = 400, description = "Paper identifier is invalid", body = ErrorResponse),
        (status = 404, description = "Paper does not exist", body = ErrorResponse),
        (status = 500, description = "Reading failed", body = ErrorResponse)
    )
)]
pub(super) async fn list_paper_revisions(
    State(state): State<AppState>,
    Path(path): Path<PaperPath>,
) -> Result<Json<PaperRevisionListResponse>, ApiError> {
    let paper_id = canonicalize_paper_id(&path.paper_id).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "paper.invalid_id",
            "paper identifier must match prodxiv:YYMM.XXXXXX using Crockford Base32",
        )
    })?;
    let revisions = state
        .store
        .list_paper_revisions(&paper_id)
        .await
        .map_err(store_error)?;
    if revisions.is_empty() {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "paper.not_found",
            "paper does not exist",
        ));
    }
    Ok(Json(PaperRevisionListResponse { revisions }))
}

pub(super) fn publication_filter(
    q: Option<String>,
    topic: Option<String>,
) -> Result<PublicationFilter, ApiError> {
    let q = normalized_filter(q, 200, "q")?;
    let topic = normalized_filter(topic, 100, "topic")?;
    if topic.as_ref().is_some_and(|topic| {
        topic.starts_with('_')
            || topic.ends_with('_')
            || !topic
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    }) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "request.invalid_topic",
            "topic must use lowercase letters, digits, and internal underscores",
        ));
    }
    Ok(PublicationFilter { q, topic })
}

fn normalized_filter(
    value: Option<String>,
    limit: usize,
    field: &str,
) -> Result<Option<String>, ApiError> {
    let Some(value) = value else { return Ok(None) };
    if value.chars().count() > limit || value.chars().any(char::is_control) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            &format!("request.invalid_{field}"),
            format!("{field} must contain at most {limit} characters and no control characters"),
        ));
    }
    let value = value.trim();
    Ok((!value.is_empty()).then(|| value.to_owned()))
}

fn encode_draft_cursor(cursor: &PublicDraftCursor) -> String {
    let mut bytes = cursor.updated_at_micros.to_be_bytes().to_vec();
    bytes.extend_from_slice(cursor.paper_uuid.as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_draft_cursor(value: &str) -> Result<PublicDraftCursor, ApiError> {
    if value.len() > 128 {
        return Err(invalid_cursor());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| invalid_cursor())?;
    let (micros, paper_uuid) = bytes.split_at_checked(8).ok_or_else(invalid_cursor)?;
    let updated_at_micros =
        i64::from_be_bytes(micros.try_into().expect("timestamp is eight bytes"));
    let paper_uuid = std::str::from_utf8(paper_uuid).map_err(|_| invalid_cursor())?;
    let paper_uuid = canonical_draft_uuid(paper_uuid).map_err(|_| invalid_cursor())?;
    if updated_at_micros <= 0 {
        return Err(invalid_cursor());
    }
    Ok(PublicDraftCursor {
        updated_at_micros,
        paper_uuid,
    })
}

#[cfg(test)]
mod tests {
    use super::{public_drafts_enabled, publication_filter};

    #[test]
    fn public_reads_are_opt_in_and_default_to_disabled() {
        for value in [
            None,
            Some(""),
            Some("false"),
            Some("1"),
            Some("TRUE"),
            Some(" true "),
        ] {
            assert!(!public_drafts_enabled(value));
        }
        assert!(public_drafts_enabled(Some("true")));
    }

    #[test]
    fn filters_have_bounded_literal_search_and_canonical_topics() {
        assert!(publication_filter(Some("a".repeat(200)), None).is_ok());
        assert!(publication_filter(Some("文".repeat(200)), None).is_ok());
        assert!(publication_filter(Some("a".repeat(201)), None).is_err());
        assert!(publication_filter(Some("line\nbreak".to_owned()), None).is_err());
        for topic in ["bad-topic", "UPPER", "_start", "end_"] {
            assert!(publication_filter(None, Some(topic.to_owned())).is_err());
        }
        let filters = publication_filter(
            Some(" 100%_literal ".to_owned()),
            Some("developer_tools".to_owned()),
        )
        .unwrap();
        assert_eq!(filters.q.as_deref(), Some("100%_literal"));
        assert_eq!(filters.topic.as_deref(), Some("developer_tools"));
        let legacy = publication_filter(None, Some("developer__tools".to_owned())).unwrap();
        assert_eq!(legacy.topic.as_deref(), Some("developer__tools"));
        let empty = publication_filter(Some(" ".to_owned()), Some(" ".to_owned())).unwrap();
        assert!(empty.q.is_none() && empty.topic.is_none());
    }
}
