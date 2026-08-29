use prodxiv_domain::{
    PublicDraftReviewStatus, PublicPaperDraft, PublicPaperDraftResponse, PublicPaperDraftSummary,
    PublishedPaperSummary, public_draft_metadata,
};
use sqlx::{Row, postgres::PgRow, types::Json};

use crate::{
    PaperMetadata, PostgresStorage, StorageError, decode_draft_owner_kind, decode_revision,
};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PublicationFilter {
    pub q: Option<String>,
    pub topic: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicDraftCursor {
    pub updated_at_micros: i64,
    pub paper_uuid: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicDraftPage {
    pub drafts: Vec<PublicPaperDraftSummary>,
    pub next_cursor: Option<PublicDraftCursor>,
}

impl PostgresStorage {
    /// Lists only current pending snapshots using one statement for content,
    /// state, and edit-order pagination. No management or audit columns are read.
    ///
    /// # Errors
    ///
    /// Returns a database or decoding error; malformed draft metadata is omitted
    /// from its summary and does not make the queue unavailable.
    pub async fn list_public_drafts(
        &self,
        limit: u32,
        cursor: Option<&PublicDraftCursor>,
    ) -> Result<PublicDraftPage, StorageError> {
        let rows = sqlx::query(
            r#"
            SELECT
              drafts.paper_uuid::text AS paper_uuid,
              drafts.current_revision,
              drafts.owner_kind,
              revisions.source_markdown,
              to_char(drafts.updated_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
              (extract(epoch FROM drafts.updated_at) * 1000000)::bigint
                AS updated_at_micros
            FROM paper_drafts AS drafts
            JOIN paper_draft_revisions AS revisions
              ON revisions.paper_uuid = drafts.paper_uuid
              AND revisions.revision = drafts.current_revision
            WHERE drafts.review_status = 'pending_review'
              AND ($1::bigint IS NULL OR (
                (extract(epoch FROM drafts.updated_at) * 1000000)::bigint,
                drafts.paper_uuid
              ) < ($1, $2::uuid))
            ORDER BY drafts.updated_at DESC, drafts.paper_uuid DESC
            LIMIT $3
            "#,
        )
        .bind(cursor.map(|cursor| cursor.updated_at_micros))
        .bind(cursor.map(|cursor| cursor.paper_uuid.as_str()))
        .bind(i64::from(limit) + 1)
        .fetch_all(&self.pool)
        .await?;
        let limit = usize::try_from(limit).unwrap_or(usize::MAX);
        let has_more = rows.len() > limit;
        let mut next_cursor = None;
        let drafts = rows
            .into_iter()
            .take(limit)
            .map(|row| {
                let draft = decode_public_draft(&row)?;
                next_cursor = Some(PublicDraftCursor {
                    updated_at_micros: row.try_get("updated_at_micros")?,
                    paper_uuid: draft.paper_uuid.clone(),
                });
                Ok(PublicPaperDraftSummary::from(&draft))
            })
            .collect::<Result<Vec<_>, StorageError>>()?;
        Ok(PublicDraftPage {
            drafts,
            next_cursor: has_more.then_some(next_cursor).flatten(),
        })
    }

    /// Resolves a UUID within one database snapshot. Draft state and current
    /// source are read together, so an approved/rejected or historical source
    /// cannot leak through a list-then-read race. Publication mappings survive
    /// removal of the mutable draft and identify the exact promoted revision.
    ///
    /// # Errors
    ///
    /// Returns a database or decoding error when stored records cannot be read.
    pub async fn find_public_draft(
        &self,
        paper_uuid: &str,
    ) -> Result<Option<PublicPaperDraftResponse>, StorageError> {
        let row = sqlx::query(
            r#"
            SELECT
              'draft'::text AS kind,
              drafts.paper_uuid::text AS paper_uuid,
              drafts.current_revision,
              drafts.owner_kind,
              revisions.source_markdown,
              to_char(drafts.updated_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
              NULL::text AS paper_id,
              NULL::integer AS paper_revision
            FROM paper_drafts AS drafts
            JOIN paper_draft_revisions AS revisions
              ON revisions.paper_uuid = drafts.paper_uuid
              AND revisions.revision = drafts.current_revision
            WHERE drafts.paper_uuid = $1::uuid
              AND drafts.review_status = 'pending_review'
            UNION ALL
            SELECT
              'published', NULL, NULL, NULL, NULL, NULL,
              paper_id, paper_revision
            FROM paper_draft_publications
            WHERE paper_uuid = $1::uuid
            "#,
        )
        .bind(paper_uuid)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            if row.try_get::<String, _>("kind")? == "published" {
                Ok(PublicPaperDraftResponse::Published {
                    paper_id: row.try_get("paper_id")?,
                    revision: decode_revision(row.try_get("paper_revision")?)?,
                })
            } else {
                Ok(PublicPaperDraftResponse::Draft {
                    draft: Box::new(decode_public_draft(&row)?),
                })
            }
        })
        .transpose()
    }

    /// Lists topics present in the latest published revision of each paper.
    ///
    /// # Errors
    ///
    /// Returns a database error when published metadata cannot be read.
    pub async fn list_paper_topics(&self) -> Result<Vec<String>, StorageError> {
        Ok(sqlx::query_scalar(
            r#"
            WITH latest_revisions AS (
              SELECT DISTINCT ON (paper_id) metadata
              FROM paper_revisions
              ORDER BY paper_id, revision DESC
            )
            SELECT DISTINCT topic
            FROM latest_revisions,
              jsonb_array_elements_text(metadata->'topics') AS topic
            ORDER BY topic
            "#,
        )
        .fetch_all(&self.pool)
        .await?)
    }

    /// Lists actual immutable revisions for one paper, newest first. An empty
    /// list means that the paper does not exist; no revision range is inferred.
    ///
    /// # Errors
    ///
    /// Returns a database or decoding error when stored records cannot be read.
    pub async fn list_paper_revisions(
        &self,
        paper_id: &str,
    ) -> Result<Vec<PublishedPaperSummary>, StorageError> {
        let rows = sqlx::query(
            r#"
            SELECT
              paper_id, papers.product_id, revision,
              published_at::text AS published_at, metadata
            FROM paper_revisions
            JOIN papers USING (paper_id)
            WHERE paper_id = $1
            ORDER BY revision DESC
            "#,
        )
        .bind(paper_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                let metadata: Json<PaperMetadata> = row.try_get("metadata")?;
                Ok(PublishedPaperSummary {
                    schema_version: metadata.schema_version.clone(),
                    paper_id: row.try_get("paper_id")?,
                    product_id: row.try_get("product_id")?,
                    revision: decode_revision(row.try_get("revision")?)?,
                    published_at: row.try_get("published_at")?,
                    metadata: metadata.0,
                })
            })
            .collect()
    }
}

fn decode_public_draft(row: &PgRow) -> Result<PublicPaperDraft, StorageError> {
    let source_markdown = row.try_get::<String, _>("source_markdown")?;
    Ok(PublicPaperDraft {
        paper_uuid: row.try_get("paper_uuid")?,
        revision: decode_revision(row.try_get("current_revision")?)?,
        owner_kind: decode_draft_owner_kind(row)?,
        review_status: PublicDraftReviewStatus::PendingReview,
        updated_at: row.try_get("updated_at")?,
        metadata: public_draft_metadata(&source_markdown),
        source_markdown,
    })
}
