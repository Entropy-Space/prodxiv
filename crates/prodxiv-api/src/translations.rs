use super::*;

async fn bot_actor<'a>(headers: &HeaderMap, state: &'a AppState) -> Result<&'a str, ApiError> {
    let principal = authorize_draft(headers, state).await?;
    if principal.owner_kind != DraftOwnerKind::Bot {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "translation.bot_required",
            "translation jobs require the bot principal",
        ));
    }
    Ok(principal.actor)
}

#[utoipa::path(get, path = "/v1/translation-jobs", security(("bearer_token" = [])), responses((status = 200, body = Vec<TranslationJob>), (status = 401, body = ErrorResponse), (status = 403, body = ErrorResponse)))]
pub(super) async fn jobs(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<TranslationJob>>, ApiError> {
    bot_actor(&headers, &state).await?;
    Ok(Json(
        state.store.translation_jobs().await.map_err(store_error)?,
    ))
}

#[utoipa::path(get, path = "/v1/papers/{paper_id}/revisions/{revision}/translations", params(("paper_id" = String, Path), ("revision" = u32, Path)), responses((status = 200, body = Vec<PaperTranslation>), (status = 404, body = ErrorResponse)))]
pub(super) async fn list(
    State(state): State<AppState>,
    Path(path): Path<RevisionPath>,
) -> Result<Json<Vec<PaperTranslation>>, ApiError> {
    let paper_id = valid_identity(&path.paper_id, path.revision)?;
    if state
        .store
        .find_revision(&paper_id, path.revision)
        .await
        .map_err(store_error)?
        .is_none()
    {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "paper.not_found",
            "paper revision does not exist",
        ));
    }
    Ok(Json(
        state
            .store
            .paper_translations(&paper_id, path.revision)
            .await
            .map_err(store_error)?,
    ))
}

#[derive(Deserialize)]
pub(super) struct JobPath {
    paper_id: String,
    revision: u32,
    language: PaperLanguage,
}

#[utoipa::path(post, path = "/v1/translation-jobs/{paper_id}/{revision}/{language}", security(("bearer_token" = [])), params(("paper_id" = String, Path), ("revision" = u32, Path), ("language" = PaperLanguage, Path)), request_body = TranslationResult, responses((status = 204, description = "Job result saved or already complete"), (status = 422, body = ErrorResponse), (status = 403, body = ErrorResponse)))]
pub(super) async fn finish(
    State(state): State<AppState>,
    Path(path): Path<JobPath>,
    headers: HeaderMap,
    input: Result<Json<TranslationResult>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    let actor = bot_actor(&headers, &state).await?;
    let paper_id = valid_identity(&path.paper_id, path.revision)?;
    let Json(result) = input.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "translation.invalid_request",
            "invalid translation result",
        )
    })?;
    state
        .store
        .finish_translation(&paper_id, path.revision, path.language, &result, actor)
        .await
        .map_err(store_error)?;
    Ok(StatusCode::NO_CONTENT)
}

fn valid_identity(paper_id: &str, revision: u32) -> Result<String, ApiError> {
    canonicalize_paper_id(paper_id)
        .filter(|_| revision > 0 && revision <= i32::MAX as u32)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "paper.invalid_id",
                "invalid paper identifier or revision",
            )
        })
}
