//! PostgreSQL persistence for immutable prodxiv publications.

use std::collections::HashMap;

use prodxiv_domain::{
    PaperDocument, PaperMetadata, PublicationIdentity, PublicationPreparationError, PublishedPaper,
    PublishedPaperSummary, canonicalize_product_id, encode_paper_id_suffix, prepare_publication,
    product_id_from_paper_id,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{
    PgPool, Row,
    migrate::{MigrateError, Migrator},
    postgres::{PgPoolOptions, PgRow},
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

pub const GITHUB_TRENDING_ANY_LANGUAGE: &str = "any";
pub const GITHUB_TRENDING_ALL_LANGUAGES: &str = "all";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitHubTrendingLanguageScope {
    Any,
    Language(String),
}

impl GitHubTrendingLanguageScope {
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        if value == GITHUB_TRENDING_ANY_LANGUAGE {
            return Some(Self::Any);
        }
        if !is_valid_language_slug(value) || value == GITHUB_TRENDING_ALL_LANGUAGES {
            return None;
        }
        Some(Self::Language(value.to_owned()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Any => GITHUB_TRENDING_ANY_LANGUAGE,
            Self::Language(language) => language,
        }
    }

    fn database_value(&self) -> Option<&str> {
        match self {
            Self::Any => None,
            Self::Language(language) => Some(language),
        }
    }

    fn from_database(value: Option<String>) -> Result<Self, StorageError> {
        match value {
            None => Ok(Self::Any),
            Some(language) => Self::parse(&language)
                .filter(|scope| !matches!(scope, Self::Any))
                .ok_or(StorageError::CorruptTrendingLanguageScope(language)),
        }
    }
}

impl Serialize for GitHubTrendingLanguageScope {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for GitHubTrendingLanguageScope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).ok_or_else(|| D::Error::custom("invalid language scope"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitHubTrendingLanguageSelector {
    Any,
    All,
    Language(String),
}

impl GitHubTrendingLanguageSelector {
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            GITHUB_TRENDING_ANY_LANGUAGE => Some(Self::Any),
            GITHUB_TRENDING_ALL_LANGUAGES => Some(Self::All),
            language if is_valid_language_slug(language) => {
                Some(Self::Language(language.to_owned()))
            }
            _ => None,
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Any => GITHUB_TRENDING_ANY_LANGUAGE,
            Self::All => GITHUB_TRENDING_ALL_LANGUAGES,
            Self::Language(language) => language,
        }
    }

    fn exact_scope(&self) -> Option<GitHubTrendingLanguageScope> {
        match self {
            Self::Any => Some(GitHubTrendingLanguageScope::Any),
            Self::All => None,
            Self::Language(language) => {
                Some(GitHubTrendingLanguageScope::Language(language.clone()))
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NewGitHubTrendingSnapshot {
    pub snapshot_date: String,
    #[serde(default)]
    pub captured_at: Option<String>,
    pub period: String,
    pub language: GitHubTrendingLanguageScope,
    #[serde(default)]
    pub spoken_language: Option<String>,
    pub source_kind: String,
    pub source_url: String,
    pub source_revision: String,
    pub entries: Vec<NewGitHubTrendingEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NewGitHubTrendingEntry {
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrendingImportOutcome {
    pub snapshot_id: i64,
    pub entry_count: usize,
    pub inserted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitHubTrendingSnapshot {
    pub snapshot_date: String,
    pub captured_at: Option<String>,
    pub period: String,
    pub language: GitHubTrendingLanguageScope,
    pub spoken_language: Option<String>,
    pub source_kind: String,
    pub source_url: String,
    pub source_revision: String,
    pub entries: Vec<GitHubTrendingEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitHubTrendingEntry {
    pub rank: u32,
    pub repository_full_name: String,
    pub repository_node_id: Option<String>,
    pub description: Option<String>,
    pub primary_language: Option<String>,
    pub stars: Option<i64>,
    pub forks: Option<i64>,
    pub stars_in_period: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHubTrendingView {
    pub snapshots: Vec<GitHubTrendingSnapshot>,
    pub previous_date: Option<String>,
    pub next_date: Option<String>,
    pub available_languages: Vec<String>,
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

    /// Imports one immutable GitHub Trending snapshot.
    ///
    /// Re-importing the same source revision and scope is an idempotent no-op.
    ///
    /// # Errors
    ///
    /// Returns an error when snapshot metadata is invalid, repository entries
    /// are duplicated, or PostgreSQL rejects the transaction.
    pub async fn import_github_trending_snapshot(
        &self,
        snapshot: &NewGitHubTrendingSnapshot,
    ) -> Result<TrendingImportOutcome, StorageError> {
        let request_sha256 = trending_request_sha256(snapshot)?;
        let idempotency_key = format!(
            "github-trending-import:{}",
            request_sha256.trim_start_matches("sha256:")
        );
        self.ingest_github_trending_snapshot(snapshot, "standalone_importer", &idempotency_key)
            .await
    }

    /// Ingests one immutable GitHub Trending snapshot for an authenticated
    /// actor and idempotency key.
    ///
    /// Reusing a key for the same semantic snapshot returns the original
    /// snapshot even when only its capture timestamp changes. Reusing it for
    /// different content is rejected.
    ///
    /// # Errors
    ///
    /// Returns an error when the actor, key, or snapshot is invalid; a key was
    /// reused for different content; or PostgreSQL rejects the transaction.
    pub async fn ingest_github_trending_snapshot(
        &self,
        snapshot: &NewGitHubTrendingSnapshot,
        actor: &str,
        idempotency_key: &str,
    ) -> Result<TrendingImportOutcome, StorageError> {
        if actor.trim().is_empty() {
            return Err(StorageError::InvalidActor);
        }
        if !is_valid_idempotency_key(idempotency_key) {
            return Err(StorageError::InvalidIdempotencyKey);
        }
        validate_trending_snapshot(snapshot)?;
        let request_sha256 = trending_request_sha256(snapshot)?;

        let mut transaction = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(idempotency_key)
            .execute(&mut *transaction)
            .await?;

        let previous_request = sqlx::query(
            r#"
            SELECT request_sha256, snapshot_id
            FROM github_trending_ingestion_requests
            WHERE idempotency_key = $1
            "#,
        )
        .bind(idempotency_key)
        .fetch_optional(&mut *transaction)
        .await?;
        if let Some(row) = previous_request {
            let previous_sha256: String = row.try_get("request_sha256")?;
            if previous_sha256 != request_sha256 {
                return Err(StorageError::IdempotencyConflict);
            }
            let snapshot_id = row.try_get("snapshot_id")?;
            transaction.commit().await?;
            return Ok(TrendingImportOutcome {
                snapshot_id,
                entry_count: snapshot.entries.len(),
                inserted: false,
            });
        }

        let inserted = sqlx::query(
            r#"
            INSERT INTO github_trending_snapshots (
              snapshot_date,
              captured_at,
              period,
              language,
              spoken_language,
              source_kind,
              source_url,
              source_revision,
              ingested_by
            )
            VALUES ($1::date, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (
              snapshot_date,
              captured_at,
              period,
              language,
              spoken_language,
              source_kind,
              source_url,
              source_revision
            ) DO NOTHING
            RETURNING snapshot_id
            "#,
        )
        .bind(&snapshot.snapshot_date)
        .bind(&snapshot.captured_at)
        .bind(&snapshot.period)
        .bind(snapshot.language.database_value())
        .bind(&snapshot.spoken_language)
        .bind(&snapshot.source_kind)
        .bind(&snapshot.source_url)
        .bind(&snapshot.source_revision)
        .bind(actor)
        .fetch_optional(&mut *transaction)
        .await?;

        let (snapshot_id, was_inserted) = if let Some(row) = inserted {
            (row.try_get("snapshot_id")?, true)
        } else {
            let row = sqlx::query(
                r#"
                SELECT snapshot_id
                FROM github_trending_snapshots
                WHERE snapshot_date = $1::date
                  AND captured_at IS NOT DISTINCT FROM $2::timestamptz
                  AND period = $3
                  AND language IS NOT DISTINCT FROM $4
                  AND spoken_language IS NOT DISTINCT FROM $5
                  AND source_kind = $6
                  AND source_url = $7
                  AND source_revision = $8
                "#,
            )
            .bind(&snapshot.snapshot_date)
            .bind(&snapshot.captured_at)
            .bind(&snapshot.period)
            .bind(snapshot.language.database_value())
            .bind(&snapshot.spoken_language)
            .bind(&snapshot.source_kind)
            .bind(&snapshot.source_url)
            .bind(&snapshot.source_revision)
            .fetch_one(&mut *transaction)
            .await?;
            (row.try_get("snapshot_id")?, false)
        };

        if was_inserted {
            for (index, entry) in snapshot.entries.iter().enumerate() {
                let rank = i32::try_from(index + 1)
                    .map_err(|_| StorageError::InvalidTrendingSnapshot("too many entries"))?;
                sqlx::query(
                    r#"
                    INSERT INTO github_trending_entries (
                      snapshot_id,
                      rank,
                      repository_full_name,
                      repository_node_id,
                      description,
                      primary_language,
                      stars,
                      forks,
                      stars_in_period
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    "#,
                )
                .bind(snapshot_id)
                .bind(rank)
                .bind(&entry.repository_full_name)
                .bind(&entry.repository_node_id)
                .bind(&entry.description)
                .bind(&entry.primary_language)
                .bind(entry.stars)
                .bind(entry.forks)
                .bind(entry.stars_in_period)
                .execute(&mut *transaction)
                .await?;
            }
        }

        sqlx::query(
            r#"
            INSERT INTO github_trending_ingestion_requests (
              idempotency_key,
              request_sha256,
              snapshot_id,
              actor
            )
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(idempotency_key)
        .bind(&request_sha256)
        .bind(snapshot_id)
        .bind(actor)
        .execute(&mut *transaction)
        .await?;

        transaction.commit().await?;
        Ok(TrendingImportOutcome {
            snapshot_id,
            entry_count: snapshot.entries.len(),
            inserted: was_inserted,
        })
    }

    /// Returns the latest snapshot for an exact Trending scope.
    ///
    /// # Errors
    ///
    /// Returns a database or decoding error when stored records cannot be read.
    pub async fn latest_github_trending(
        &self,
        period: &str,
        language: &GitHubTrendingLanguageScope,
        spoken_language: Option<&str>,
    ) -> Result<Option<GitHubTrendingSnapshot>, StorageError> {
        self.github_trending_snapshot(period, language, spoken_language, None)
            .await
    }

    /// Returns matching snapshots plus navigation derived from imported history.
    ///
    /// # Errors
    ///
    /// Returns a database or decoding error when stored records cannot be read.
    pub async fn github_trending_view(
        &self,
        period: &str,
        language: &GitHubTrendingLanguageSelector,
        spoken_language: Option<&str>,
        snapshot_date: Option<&str>,
    ) -> Result<GitHubTrendingView, StorageError> {
        let exact_scope = language.exact_scope();
        let exact_snapshot = if let Some(scope) = exact_scope.as_ref() {
            self.github_trending_snapshot(period, scope, spoken_language, snapshot_date)
                .await?
        } else {
            None
        };
        let latest_all_date = if language == &GitHubTrendingLanguageSelector::All
            && exact_snapshot.is_none()
            && snapshot_date.is_none()
        {
            sqlx::query_scalar::<_, Option<String>>(
                r#"
                SELECT max(snapshot_date)::text
                FROM github_trending_snapshots
                WHERE period = $1
                  AND spoken_language IS NOT DISTINCT FROM $2
                "#,
            )
            .bind(period)
            .bind(spoken_language)
            .fetch_one(&self.pool)
            .await?
        } else {
            None
        };
        let anchor_date = exact_snapshot
            .as_ref()
            .map(|value| value.snapshot_date.as_str())
            .or(snapshot_date)
            .or(latest_all_date.as_deref());
        let Some(anchor_date) = anchor_date else {
            return Ok(GitHubTrendingView {
                snapshots: Vec::new(),
                previous_date: None,
                next_date: None,
                available_languages: Vec::new(),
            });
        };
        let navigation = if language == &GitHubTrendingLanguageSelector::All {
            sqlx::query(
                r#"
                SELECT
                  (
                    SELECT max(snapshot_date)::text
                    FROM github_trending_snapshots
                    WHERE period = $1
                      AND spoken_language IS NOT DISTINCT FROM $2
                      AND snapshot_date < $3::date
                  ) AS previous_date,
                  (
                    SELECT min(snapshot_date)::text
                    FROM github_trending_snapshots
                    WHERE period = $1
                      AND spoken_language IS NOT DISTINCT FROM $2
                      AND snapshot_date > $3::date
                  ) AS next_date
                "#,
            )
            .bind(period)
            .bind(spoken_language)
            .bind(anchor_date)
            .fetch_one(&self.pool)
            .await?
        } else {
            let database_language = exact_scope
                .as_ref()
                .expect("non-all selectors have an exact scope")
                .database_value();
            sqlx::query(
                r#"
                SELECT
                  (
                    SELECT max(snapshot_date)::text
                    FROM github_trending_snapshots
                    WHERE period = $1
                      AND language IS NOT DISTINCT FROM $2
                      AND spoken_language IS NOT DISTINCT FROM $3
                      AND snapshot_date < $4::date
                  ) AS previous_date,
                  (
                    SELECT min(snapshot_date)::text
                    FROM github_trending_snapshots
                    WHERE period = $1
                      AND language IS NOT DISTINCT FROM $2
                      AND spoken_language IS NOT DISTINCT FROM $3
                      AND snapshot_date > $4::date
                  ) AS next_date
                "#,
            )
            .bind(period)
            .bind(database_language)
            .bind(spoken_language)
            .bind(anchor_date)
            .fetch_one(&self.pool)
            .await?
        };
        let language_rows = sqlx::query(
            r#"
            SELECT DISTINCT language
            FROM github_trending_snapshots
            WHERE period = $1
              AND snapshot_date = $2::date
              AND spoken_language IS NOT DISTINCT FROM $3
              AND language IS NOT NULL
            ORDER BY language
            "#,
        )
        .bind(period)
        .bind(anchor_date)
        .bind(spoken_language)
        .fetch_all(&self.pool)
        .await?;
        let available_languages = language_rows
            .into_iter()
            .map(|row| {
                let language: String = row.try_get("language")?;
                let scope = GitHubTrendingLanguageScope::from_database(Some(language))?;
                Ok(scope.as_str().to_owned())
            })
            .collect::<Result<Vec<String>, StorageError>>()?;

        let snapshots = if language == &GitHubTrendingLanguageSelector::All {
            self.github_trending_snapshots_for_date(period, spoken_language, anchor_date)
                .await?
        } else {
            exact_snapshot.into_iter().collect()
        };

        Ok(GitHubTrendingView {
            snapshots,
            previous_date: navigation.try_get("previous_date")?,
            next_date: navigation.try_get("next_date")?,
            available_languages,
        })
    }

    async fn github_trending_snapshot(
        &self,
        period: &str,
        language: &GitHubTrendingLanguageScope,
        spoken_language: Option<&str>,
        snapshot_date: Option<&str>,
    ) -> Result<Option<GitHubTrendingSnapshot>, StorageError> {
        let row = sqlx::query(
            r#"
            SELECT
              snapshot_id,
              snapshot_date::text AS snapshot_date,
              captured_at::text AS captured_at,
              period,
              language,
              spoken_language,
              source_kind,
              source_url,
              source_revision
            FROM github_trending_snapshots
            WHERE period = $1
              AND language IS NOT DISTINCT FROM $2
              AND spoken_language IS NOT DISTINCT FROM $3
              AND ($4::date IS NULL OR snapshot_date = $4::date)
            ORDER BY snapshot_date DESC, created_at DESC, snapshot_id DESC
            LIMIT 1
            "#,
        )
        .bind(period)
        .bind(language.database_value())
        .bind(spoken_language)
        .bind(snapshot_date)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let snapshot_id: i64 = row.try_get("snapshot_id")?;
        let entry_rows = sqlx::query(
            r#"
            SELECT
              rank,
              repository_full_name,
              repository_node_id,
              description,
              primary_language,
              stars,
              forks,
              stars_in_period
            FROM github_trending_entries
            WHERE snapshot_id = $1
            ORDER BY rank
            "#,
        )
        .bind(snapshot_id)
        .fetch_all(&self.pool)
        .await?;
        let entries = entry_rows
            .iter()
            .map(decode_github_trending_entry)
            .collect::<Result<Vec<_>, StorageError>>()?;

        Ok(Some(decode_github_trending_snapshot(&row, entries)?))
    }

    async fn github_trending_snapshots_for_date(
        &self,
        period: &str,
        spoken_language: Option<&str>,
        snapshot_date: &str,
    ) -> Result<Vec<GitHubTrendingSnapshot>, StorageError> {
        let snapshot_rows = sqlx::query(
            r#"
            SELECT DISTINCT ON (language)
              snapshot_id,
              snapshot_date::text AS snapshot_date,
              captured_at::text AS captured_at,
              period,
              language,
              spoken_language,
              source_kind,
              source_url,
              source_revision
            FROM github_trending_snapshots
            WHERE period = $1
              AND spoken_language IS NOT DISTINCT FROM $2
              AND snapshot_date = $3::date
            ORDER BY language NULLS FIRST, created_at DESC, snapshot_id DESC
            "#,
        )
        .bind(period)
        .bind(spoken_language)
        .bind(snapshot_date)
        .fetch_all(&self.pool)
        .await?;
        if snapshot_rows.is_empty() {
            return Ok(Vec::new());
        }
        let snapshot_ids = snapshot_rows
            .iter()
            .map(|row| row.try_get("snapshot_id"))
            .collect::<Result<Vec<i64>, sqlx::Error>>()?;
        let entry_rows = sqlx::query(
            r#"
            SELECT
              snapshot_id,
              rank,
              repository_full_name,
              repository_node_id,
              description,
              primary_language,
              stars,
              forks,
              stars_in_period
            FROM github_trending_entries
            WHERE snapshot_id = ANY($1)
            ORDER BY snapshot_id, rank
            "#,
        )
        .bind(&snapshot_ids)
        .fetch_all(&self.pool)
        .await?;
        let mut entries_by_snapshot = HashMap::<i64, Vec<GitHubTrendingEntry>>::new();
        for row in &entry_rows {
            entries_by_snapshot
                .entry(row.try_get("snapshot_id")?)
                .or_default()
                .push(decode_github_trending_entry(row)?);
        }

        snapshot_rows
            .iter()
            .map(|row| {
                let snapshot_id = row.try_get("snapshot_id")?;
                decode_github_trending_snapshot(
                    row,
                    entries_by_snapshot.remove(&snapshot_id).unwrap_or_default(),
                )
            })
            .collect()
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
}

fn decode_github_trending_snapshot(
    row: &PgRow,
    entries: Vec<GitHubTrendingEntry>,
) -> Result<GitHubTrendingSnapshot, StorageError> {
    Ok(GitHubTrendingSnapshot {
        snapshot_date: row.try_get("snapshot_date")?,
        captured_at: row.try_get("captured_at")?,
        period: row.try_get("period")?,
        language: GitHubTrendingLanguageScope::from_database(row.try_get("language")?)?,
        spoken_language: row.try_get("spoken_language")?,
        source_kind: row.try_get("source_kind")?,
        source_url: row.try_get("source_url")?,
        source_revision: row.try_get("source_revision")?,
        entries,
    })
}

fn decode_github_trending_entry(row: &PgRow) -> Result<GitHubTrendingEntry, StorageError> {
    let rank: i32 = row.try_get("rank")?;
    Ok(GitHubTrendingEntry {
        rank: u32::try_from(rank).map_err(|_| StorageError::CorruptTrendingRank(rank))?,
        repository_full_name: row.try_get("repository_full_name")?,
        repository_node_id: row.try_get("repository_node_id")?,
        description: row.try_get("description")?,
        primary_language: row.try_get("primary_language")?,
        stars: row.try_get("stars")?,
        forks: row.try_get("forks")?,
        stars_in_period: row.try_get("stars_in_period")?,
    })
}

fn trending_request_sha256(snapshot: &NewGitHubTrendingSnapshot) -> Result<String, StorageError> {
    let mut semantic_snapshot = snapshot.clone();
    semantic_snapshot.captured_at = None;
    let serialized = serde_json::to_vec(&semantic_snapshot)?;
    Ok(format!("sha256:{:x}", Sha256::digest(serialized)))
}

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("database operation failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("database migration failed: {0}")]
    Migration(#[from] MigrateError),
    #[error("publication preparation failed: {0}")]
    Publication(#[from] PublicationPreparationError),
    #[error("operation actor must not be empty")]
    InvalidActor,
    #[error("idempotency key is invalid")]
    InvalidIdempotencyKey,
    #[error("idempotency key was already used for different content")]
    IdempotencyConflict,
    #[error("paper identifier space for period {period} is exhausted")]
    IdentifierSpaceExhausted { period: String },
    #[error("stored paper revision {0} is invalid")]
    CorruptRevision(i32),
    #[error("product identifier is invalid")]
    InvalidProductId,
    #[error("product {0} does not exist")]
    UnknownProduct(String),
    #[error("GitHub Trending snapshot is invalid: {0}")]
    InvalidTrendingSnapshot(&'static str),
    #[error("GitHub Trending snapshot could not be serialized: {0}")]
    TrendingSerialization(#[from] serde_json::Error),
    #[error("stored GitHub Trending rank {0} is invalid")]
    CorruptTrendingRank(i32),
    #[error("stored GitHub Trending language scope {0} is invalid")]
    CorruptTrendingLanguageScope(String),
}

fn validate_trending_snapshot(snapshot: &NewGitHubTrendingSnapshot) -> Result<(), StorageError> {
    if !is_iso_date(&snapshot.snapshot_date) {
        return Err(StorageError::InvalidTrendingSnapshot(
            "snapshot_date must be a real YYYY-MM-DD date",
        ));
    }
    if snapshot
        .captured_at
        .as_deref()
        .is_some_and(|value| !is_utc_second(value))
    {
        return Err(StorageError::InvalidTrendingSnapshot(
            "captured_at must use YYYY-MM-DDTHH:MM:SSZ in UTC",
        ));
    }
    if !matches!(snapshot.period.as_str(), "daily" | "weekly" | "monthly") {
        return Err(StorageError::InvalidTrendingSnapshot(
            "period must be daily, weekly, or monthly",
        ));
    }
    if !matches!(
        snapshot.source_kind.as_str(),
        "direct_fetch" | "third_party_archive" | "wayback_reconstruction"
    ) {
        return Err(StorageError::InvalidTrendingSnapshot(
            "source_kind is not recognized",
        ));
    }
    if snapshot.source_url.trim().is_empty() || snapshot.source_revision.trim().is_empty() {
        return Err(StorageError::InvalidTrendingSnapshot(
            "source_url and source_revision are required",
        ));
    }
    if matches!(
        &snapshot.language,
        GitHubTrendingLanguageScope::Language(scope)
            if !is_valid_language_slug(scope)
                || matches!(
                    scope.as_str(),
                    GITHUB_TRENDING_ANY_LANGUAGE | GITHUB_TRENDING_ALL_LANGUAGES
                )
    ) {
        return Err(StorageError::InvalidTrendingSnapshot(
            "language must be any or a concrete language slug; all is query-only",
        ));
    }
    if snapshot
        .spoken_language
        .as_deref()
        .is_some_and(|scope| scope.trim().is_empty() || scope.chars().any(char::is_whitespace))
    {
        return Err(StorageError::InvalidTrendingSnapshot(
            "spoken-language scope must not be empty or contain whitespace",
        ));
    }
    if snapshot.entries.len() > 100 {
        return Err(StorageError::InvalidTrendingSnapshot(
            "a snapshot must not contain more than 100 entries",
        ));
    }
    if snapshot.source_kind == "direct_fetch" {
        let captured_at =
            snapshot
                .captured_at
                .as_deref()
                .ok_or(StorageError::InvalidTrendingSnapshot(
                    "direct fetches require captured_at",
                ))?;
        if !captured_at.starts_with(&snapshot.snapshot_date) {
            return Err(StorageError::InvalidTrendingSnapshot(
                "direct fetch snapshot_date must match captured_at",
            ));
        }
        if !snapshot
            .source_url
            .starts_with("https://github.com/trending")
        {
            return Err(StorageError::InvalidTrendingSnapshot(
                "direct fetch source_url must identify GitHub Trending",
            ));
        }
        let entries = serde_json::to_vec(&snapshot.entries)?;
        let expected_revision = format!("sha256:{:x}", Sha256::digest(entries));
        if snapshot.source_revision != expected_revision {
            return Err(StorageError::InvalidTrendingSnapshot(
                "direct fetch source_revision must hash the normalized entries",
            ));
        }
        if snapshot.entries.iter().any(|entry| {
            entry.stars.is_none() || entry.forks.is_none() || entry.stars_in_period.is_none()
        }) {
            return Err(StorageError::InvalidTrendingSnapshot(
                "direct fetch entries require stars, forks, and period stars",
            ));
        }
    }
    let mut repository_names = std::collections::HashSet::new();
    for entry in &snapshot.entries {
        let mut parts = entry.repository_full_name.split('/');
        let valid_name = parts
            .next()
            .is_some_and(|part| !part.is_empty() && !part.chars().any(char::is_whitespace))
            && parts
                .next()
                .is_some_and(|part| !part.is_empty() && !part.chars().any(char::is_whitespace))
            && parts.next().is_none();
        if !valid_name {
            return Err(StorageError::InvalidTrendingSnapshot(
                "repository_full_name must be owner/name",
            ));
        }
        if !repository_names.insert(entry.repository_full_name.to_ascii_lowercase()) {
            return Err(StorageError::InvalidTrendingSnapshot(
                "repository names must be unique",
            ));
        }
        if [entry.stars, entry.forks, entry.stars_in_period]
            .into_iter()
            .flatten()
            .any(|value| value < 0)
        {
            return Err(StorageError::InvalidTrendingSnapshot(
                "repository counts must not be negative",
            ));
        }
    }
    Ok(())
}

fn is_valid_language_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value.bytes().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, b'#' | b'+' | b'.' | b'-')
        })
}

fn is_iso_date(value: &str) -> bool {
    if value.len() != 10 {
        return false;
    }
    let parts = value
        .split('-')
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>();
    let Ok(parts) = parts else {
        return false;
    };
    if parts.len() != 3 {
        return false;
    }
    let (year, month, day) = (parts[0], parts[1], parts[2]);
    if year == 0 {
        return false;
    }
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

fn is_utc_second(value: &str) -> bool {
    if !value.is_ascii()
        || value.len() != 20
        || value.as_bytes().get(10) != Some(&b'T')
        || !value.ends_with('Z')
        || value.as_bytes().get(13) != Some(&b':')
        || value.as_bytes().get(16) != Some(&b':')
        || !is_iso_date(&value[..10])
    {
        return false;
    }
    let hour = value[11..13].parse::<u8>();
    let minute = value[14..16].parse::<u8>();
    let second = value[17..19].parse::<u8>();
    matches!((hour, minute, second), (Ok(0..=23), Ok(0..=59), Ok(0..=59)))
}
