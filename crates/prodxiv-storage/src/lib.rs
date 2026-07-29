//! PostgreSQL persistence for immutable prodxiv publications.

use prodxiv_domain::{
    PaperDocument, PaperMetadata, PublicationIdentity, PublicationPreparationError, PublishedPaper,
    PublishedPaperSummary, canonicalize_product_id, encode_paper_id_suffix, prepare_publication,
    product_id_from_paper_id,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{
    PgPool, Row,
    migrate::{MigrateError, Migrator},
    postgres::PgPoolOptions,
    types::Json,
};
use thiserror::Error;

pub static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

#[derive(Debug, Clone)]
pub struct PostgresStorage {
    pool: PgPool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishOutcome {
    pub paper: PublishedPaper,
    pub replayed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicationCursor {
    pub created_at_micros: i64,
    pub paper_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicationPage {
    pub papers: Vec<PublishedPaperSummary>,
    pub next_cursor: Option<PublicationCursor>,
}

#[must_use]
pub fn is_valid_idempotency_key(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

impl PostgresStorage {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Connects to PostgreSQL without running migrations.
    ///
    /// # Errors
    ///
    /// Returns a database error when the connection pool cannot be established.
    pub async fn connect(database_url: &str, max_connections: u32) -> Result<Self, StorageError> {
        let pool = PgPoolOptions::new()
            .max_connections(max_connections)
            .connect(database_url)
            .await?;
        Ok(Self::new(pool))
    }

    /// Runs all embedded database migrations.
    ///
    /// # Errors
    ///
    /// Returns a migration error when PostgreSQL cannot apply the schema.
    pub async fn migrate(&self) -> Result<(), StorageError> {
        MIGRATOR.run(&self.pool).await?;
        Ok(())
    }

    /// Publishes the first immutable revision of a new paper.
    ///
    /// Identifier allocation, publication preparation, persistence, and audit
    /// logging happen in one transaction.
    ///
    /// # Errors
    ///
    /// Returns an error when the actor or idempotency key is invalid, the key
    /// was already used for different content, the monthly identifier space is
    /// exhausted, the finalized paper is invalid, or PostgreSQL rejects the
    /// transaction.
    pub async fn publish_new(
        &self,
        paper: PaperDocument,
        submitted_markdown: &str,
        actor: &str,
        idempotency_key: &str,
        requested_product_id: Option<&str>,
    ) -> Result<PublishOutcome, StorageError> {
        if actor.trim().is_empty() {
            return Err(StorageError::InvalidActor);
        }
        if !is_valid_idempotency_key(idempotency_key) {
            return Err(StorageError::InvalidIdempotencyKey);
        }
        let requested_product_id = requested_product_id
            .map(|product_id| {
                canonicalize_product_id(product_id).ok_or(StorageError::InvalidProductId)
            })
            .transpose()?;
        let creates_product = requested_product_id.is_none();

        let mut transaction = self.pool.begin().await?;
        let mut request_hasher = Sha256::new();
        request_hasher.update(submitted_markdown.as_bytes());
        request_hasher.update([0]);
        request_hasher.update(
            requested_product_id
                .as_deref()
                .unwrap_or_default()
                .as_bytes(),
        );
        let request_sha256 = format!("{:x}", request_hasher.finalize());
        let lock_key = format!("{}:{actor}{idempotency_key}", actor.len());
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(lock_key)
            .execute(&mut *transaction)
            .await?;

        let existing = sqlx::query(
            r#"
            SELECT
              publication_requests.request_sha256,
              papers.product_id,
              paper_revisions.paper_id,
              paper_revisions.revision,
              paper_revisions.published_at::text AS published_at,
              paper_revisions.metadata,
              paper_revisions.source_markdown
            FROM publication_requests
            JOIN paper_revisions USING (paper_id, revision)
            JOIN papers USING (paper_id)
            WHERE publication_requests.actor = $1
              AND publication_requests.idempotency_key = $2
            "#,
        )
        .bind(actor)
        .bind(idempotency_key)
        .fetch_optional(&mut *transaction)
        .await?;
        if let Some(row) = existing {
            let existing_sha256: String = row.try_get("request_sha256")?;
            if existing_sha256 != request_sha256 {
                return Err(StorageError::IdempotencyConflict);
            }
            let metadata: Json<PaperMetadata> = row.try_get("metadata")?;
            let revision: i32 = row.try_get("revision")?;
            let paper = PublishedPaper {
                schema_version: metadata.schema_version.clone(),
                paper_id: row.try_get("paper_id")?,
                product_id: row.try_get("product_id")?,
                revision: u32::try_from(revision)
                    .map_err(|_| StorageError::CorruptRevision(revision))?,
                published_at: row.try_get("published_at")?,
                metadata: metadata.0,
                source_markdown: row.try_get("source_markdown")?,
            };
            transaction.commit().await?;
            return Ok(PublishOutcome {
                paper,
                replayed: true,
            });
        }

        let clock = sqlx::query(
            "SELECT to_char(CURRENT_DATE, 'YYMM') AS period, CURRENT_DATE::text AS published_at",
        )
        .fetch_one(&mut *transaction)
        .await?;
        let period: String = clock.try_get("period")?;
        let published_at: String = clock.try_get("published_at")?;

        let sequence = sqlx::query(
            r#"
            INSERT INTO paper_id_sequences (period, last_value)
            VALUES ($1, 1)
            ON CONFLICT (period) DO UPDATE
            SET last_value = paper_id_sequences.last_value + 1
            WHERE paper_id_sequences.last_value < 1073741823
            RETURNING last_value
            "#,
        )
        .bind(&period)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(sequence) = sequence else {
            return Err(StorageError::IdentifierSpaceExhausted { period });
        };
        let sequence: i64 = sequence.try_get("last_value")?;
        let encoded = u32::try_from(sequence)
            .ok()
            .and_then(encode_paper_id_suffix)
            .ok_or_else(|| StorageError::IdentifierSpaceExhausted {
                period: period.clone(),
            })?;
        let paper_id = format!("prodxiv:{period}.{encoded}");
        let product_id = if let Some(product_id) = requested_product_id.as_ref() {
            let exists = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM products WHERE product_id = $1)",
            )
            .bind(product_id)
            .fetch_one(&mut *transaction)
            .await?;
            if !exists {
                return Err(StorageError::UnknownProduct(product_id.clone()));
            }
            product_id.clone()
        } else {
            product_id_from_paper_id(&paper_id).expect("allocated paper identifiers are canonical")
        };

        let published = prepare_publication(
            paper,
            PublicationIdentity {
                paper_id: paper_id.clone(),
                revision: 1,
                published_at,
            },
            product_id.clone(),
        )?;

        if creates_product {
            sqlx::query("INSERT INTO products (product_id, initial_name) VALUES ($1, $2)")
                .bind(&product_id)
                .bind(
                    published
                        .metadata
                        .product_name
                        .as_deref()
                        .expect("publication validation requires a product name"),
                )
                .execute(&mut *transaction)
                .await?;
        }

        sqlx::query("INSERT INTO papers (paper_id, product_id) VALUES ($1, $2)")
            .bind(&paper_id)
            .bind(&product_id)
            .execute(&mut *transaction)
            .await?;

        sqlx::query(
            r#"
            INSERT INTO paper_revisions (
              paper_id,
              revision,
              published_at,
              published_by,
              metadata,
              submitted_markdown,
              source_markdown
            )
            VALUES ($1, $2, $3::date, $4, $5, $6, $7)
            "#,
        )
        .bind(&published.paper_id)
        .bind(i32::try_from(published.revision).expect("revision one fits in i32"))
        .bind(&published.published_at)
        .bind(actor)
        .bind(Json(published.metadata.clone()))
        .bind(submitted_markdown)
        .bind(&published.source_markdown)
        .execute(&mut *transaction)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO audit_log (action, actor, paper_id, revision, details)
            VALUES ('paper.published', $1, $2, $3, $4)
            "#,
        )
        .bind(actor)
        .bind(&published.paper_id)
        .bind(i32::try_from(published.revision).expect("revision one fits in i32"))
        .bind(Json(json!({
          "schema_version": published.schema_version,
        })))
        .execute(&mut *transaction)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO publication_requests (
              actor,
              idempotency_key,
              request_sha256,
              paper_id,
              revision
            )
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(actor)
        .bind(idempotency_key)
        .bind(request_sha256)
        .bind(&published.paper_id)
        .bind(i32::try_from(published.revision).expect("revision one fits in i32"))
        .execute(&mut *transaction)
        .await?;

        for (kind, url) in [
            ("homepage", published.metadata.product_url.as_deref()),
            ("repository", published.metadata.repository_url.as_deref()),
        ] {
            if let Some(url) = url {
                sqlx::query(
                    r#"
                    INSERT INTO product_resources (
                      product_id,
                      kind,
                      canonical_url,
                      discovered_from_paper_id,
                      discovered_from_revision
                    )
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (product_id, kind, canonical_url) DO NOTHING
                    "#,
                )
                .bind(&product_id)
                .bind(kind)
                .bind(url)
                .bind(&published.paper_id)
                .bind(i32::try_from(published.revision).expect("revision one fits in i32"))
                .execute(&mut *transaction)
                .await?;
            }
        }

        transaction.commit().await?;
        Ok(PublishOutcome {
            paper: published,
            replayed: false,
        })
    }

    /// Finds one exact immutable paper revision.
    ///
    /// # Errors
    ///
    /// Returns a database or decoding error when the stored record cannot be
    /// read.
    pub async fn find_revision(
        &self,
        paper_id: &str,
        revision: u32,
    ) -> Result<Option<PublishedPaper>, StorageError> {
        let Ok(revision) = i32::try_from(revision) else {
            return Ok(None);
        };
        let row = sqlx::query(
            r#"
            SELECT
              paper_id,
              papers.product_id,
              revision,
              published_at::text AS published_at,
              metadata,
              source_markdown
            FROM paper_revisions
            JOIN papers USING (paper_id)
            WHERE paper_id = $1 AND revision = $2
            "#,
        )
        .bind(paper_id)
        .bind(revision)
        .fetch_optional(&self.pool)
        .await?;

        row.map(|row| {
            let metadata: Json<PaperMetadata> = row.try_get("metadata")?;
            let revision: i32 = row.try_get("revision")?;
            Ok(PublishedPaper {
                schema_version: metadata.schema_version.clone(),
                paper_id: row.try_get("paper_id")?,
                product_id: row.try_get("product_id")?,
                revision: u32::try_from(revision)
                    .map_err(|_| StorageError::CorruptRevision(revision))?,
                published_at: row.try_get("published_at")?,
                metadata: metadata.0,
                source_markdown: row.try_get("source_markdown")?,
            })
        })
        .transpose()
    }

    /// Lists the latest immutable revision of each paper in reverse publication
    /// order.
    ///
    /// # Errors
    ///
    /// Returns a database or decoding error when stored records cannot be read.
    pub async fn list_latest(
        &self,
        limit: u32,
        cursor: Option<&PublicationCursor>,
    ) -> Result<PublicationPage, StorageError> {
        let fetch_limit = i64::from(limit) + 1;
        let cursor_micros = cursor.map(|value| value.created_at_micros);
        let cursor_paper_id = cursor.map(|value| value.paper_id.as_str());
        let rows = sqlx::query(
            r#"
            WITH latest_revisions AS (
              SELECT DISTINCT ON (paper_id)
                paper_id,
                revision,
                published_at,
                metadata,
                created_at
              FROM paper_revisions
              ORDER BY paper_id, revision DESC
            )
            SELECT
              paper_id,
              papers.product_id,
              revision,
              published_at::text AS published_at,
              metadata,
              (
                extract(epoch FROM latest_revisions.created_at) * 1000000
              )::bigint AS created_at_micros
            FROM latest_revisions
            JOIN papers USING (paper_id)
            WHERE $1::bigint IS NULL
              OR (
                (
                  extract(epoch FROM latest_revisions.created_at) * 1000000
                )::bigint,
                paper_id
              ) < ($1, $2)
            ORDER BY latest_revisions.created_at DESC, paper_id DESC
            LIMIT $3
            "#,
        )
        .bind(cursor_micros)
        .bind(cursor_paper_id)
        .bind(fetch_limit)
        .fetch_all(&self.pool)
        .await?;

        let has_more = rows.len() > usize::try_from(limit).unwrap_or(usize::MAX);
        let mut entries = rows
            .into_iter()
            .take(usize::try_from(limit).unwrap_or(usize::MAX))
            .map(|row| {
                let metadata: Json<PaperMetadata> = row.try_get("metadata")?;
                let revision: i32 = row.try_get("revision")?;
                let paper_id: String = row.try_get("paper_id")?;
                let summary = PublishedPaperSummary {
                    schema_version: metadata.schema_version.clone(),
                    paper_id: paper_id.clone(),
                    product_id: row.try_get("product_id")?,
                    revision: u32::try_from(revision)
                        .map_err(|_| StorageError::CorruptRevision(revision))?,
                    published_at: row.try_get("published_at")?,
                    metadata: metadata.0,
                };
                Ok((
                    summary,
                    PublicationCursor {
                        created_at_micros: row.try_get("created_at_micros")?,
                        paper_id,
                    },
                ))
            })
            .collect::<Result<Vec<_>, StorageError>>()?;
        let next_cursor = has_more
            .then(|| entries.last().map(|(_, cursor)| cursor.clone()))
            .flatten();
        let papers = entries.drain(..).map(|(paper, _)| paper).collect();

        Ok(PublicationPage {
            papers,
            next_cursor,
        })
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
}

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("database operation failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("database migration failed: {0}")]
    Migration(#[from] MigrateError),
    #[error("publication preparation failed: {0}")]
    Publication(#[from] PublicationPreparationError),
    #[error("publication actor must not be empty")]
    InvalidActor,
    #[error("publication idempotency key is invalid")]
    InvalidIdempotencyKey,
    #[error("publication idempotency key was already used for different content")]
    IdempotencyConflict,
    #[error("paper identifier space for period {period} is exhausted")]
    IdentifierSpaceExhausted { period: String },
    #[error("stored paper revision {0} is invalid")]
    CorruptRevision(i32),
    #[error("product identifier is invalid")]
    InvalidProductId,
    #[error("product {0} does not exist")]
    UnknownProduct(String),
}
