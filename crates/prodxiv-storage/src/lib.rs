//! PostgreSQL persistence for immutable prodxiv publications.

use prodxiv_domain::{
    PaperDocument, PaperMetadata, PublicationIdentity, PublicationPreparationError, PublishedPaper,
    encode_paper_id_suffix, prepare_publication,
};
use serde_json::json;
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

    /// Publishes the first immutable version of a new paper.
    ///
    /// Identifier allocation, publication preparation, persistence, and audit
    /// logging happen in one transaction.
    ///
    /// # Errors
    ///
    /// Returns an error when the actor is empty, the monthly identifier space
    /// is exhausted, the finalized paper is invalid, or PostgreSQL rejects the
    /// transaction.
    pub async fn publish_new(
        &self,
        paper: PaperDocument,
        submitted_markdown: &str,
        actor: &str,
    ) -> Result<PublishedPaper, StorageError> {
        if actor.trim().is_empty() {
            return Err(StorageError::InvalidActor);
        }

        let mut transaction = self.pool.begin().await?;
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

        let published = prepare_publication(
            paper,
            PublicationIdentity {
                paper_id: paper_id.clone(),
                version: 1,
                published_at,
            },
        )?;

        sqlx::query("INSERT INTO papers (paper_id) VALUES ($1)")
            .bind(&paper_id)
            .execute(&mut *transaction)
            .await?;

        sqlx::query(
            r#"
            INSERT INTO paper_versions (
              paper_id,
              version,
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
        .bind(i32::try_from(published.version).expect("version one fits in i32"))
        .bind(&published.published_at)
        .bind(actor)
        .bind(Json(published.metadata.clone()))
        .bind(submitted_markdown)
        .bind(&published.source_markdown)
        .execute(&mut *transaction)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO audit_log (action, actor, paper_id, version, details)
            VALUES ('paper.published', $1, $2, $3, $4)
            "#,
        )
        .bind(actor)
        .bind(&published.paper_id)
        .bind(i32::try_from(published.version).expect("version one fits in i32"))
        .bind(Json(json!({
          "schema_version": published.schema_version,
        })))
        .execute(&mut *transaction)
        .await?;

        transaction.commit().await?;
        Ok(published)
    }

    /// Finds one exact immutable paper version.
    ///
    /// # Errors
    ///
    /// Returns a database or decoding error when the stored record cannot be
    /// read.
    pub async fn find_version(
        &self,
        paper_id: &str,
        version: u32,
    ) -> Result<Option<PublishedPaper>, StorageError> {
        let Ok(version) = i32::try_from(version) else {
            return Ok(None);
        };
        let row = sqlx::query(
            r#"
            SELECT
              paper_id,
              version,
              published_at::text AS published_at,
              metadata,
              source_markdown
            FROM paper_versions
            WHERE paper_id = $1 AND version = $2
            "#,
        )
        .bind(paper_id)
        .bind(version)
        .fetch_optional(&self.pool)
        .await?;

        row.map(|row| {
            let metadata: Json<PaperMetadata> = row.try_get("metadata")?;
            let version: i32 = row.try_get("version")?;
            Ok(PublishedPaper {
                schema_version: metadata.schema_version.clone(),
                paper_id: row.try_get("paper_id")?,
                version: u32::try_from(version)
                    .map_err(|_| StorageError::CorruptVersion(version))?,
                published_at: row.try_get("published_at")?,
                metadata: metadata.0,
                source_markdown: row.try_get("source_markdown")?,
            })
        })
        .transpose()
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
    #[error("paper identifier space for period {period} is exhausted")]
    IdentifierSpaceExhausted { period: String },
    #[error("stored paper version {0} is invalid")]
    CorruptVersion(i32),
}
