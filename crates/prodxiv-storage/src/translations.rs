use prodxiv_domain::{
    PaperDocument, PaperLanguage, PaperTranslation, TranslationJob, TranslationResult,
    validate_translation,
};
use sha2::{Digest, Sha256};
use sqlx::{Row, types::Json};

use crate::{PostgresStorage, StorageError};

impl PostgresStorage {
    /// Reads a bounded retry queue. Concurrent workers may compute the same job;
    /// completion is serialized and immutable, so the first valid result wins.
    ///
    /// # Errors
    /// Returns storage or decoding errors.
    pub async fn translation_jobs(&self) -> Result<Vec<TranslationJob>, StorageError> {
        let rows = sqlx::query("SELECT paper_id, revision, language, attempts FROM paper_translation_jobs WHERE NOT completed AND attempts < 3 ORDER BY created_at, paper_id, revision, language LIMIT 20")
            .fetch_all(&self.pool).await?;
        let mut jobs = Vec::new();
        for row in rows {
            let paper_id: String = row.try_get("paper_id")?;
            let revision: i32 = row.try_get("revision")?;
            let language: String = row.try_get("language")?;
            let language = serde_json::from_value(serde_json::Value::String(language))
                .map_err(|_| StorageError::InvalidTranslation("invalid stored language"))?;
            if let Some(paper) = self.find_revision(&paper_id, revision as u32).await? {
                jobs.push(TranslationJob {
                    source_sha256: format!(
                        "{:x}",
                        Sha256::digest(paper.source_markdown.as_bytes())
                    ),
                    paper,
                    language,
                    attempts: row.try_get::<i32, _>("attempts")? as u32,
                });
            }
        }
        Ok(jobs)
    }

    /// # Errors
    /// Returns storage or decoding errors.
    pub async fn paper_translations(
        &self,
        paper_id: &str,
        revision: u32,
    ) -> Result<Vec<PaperTranslation>, StorageError> {
        let rows = sqlx::query("SELECT content FROM paper_translations WHERE paper_id = $1 AND revision = $2 ORDER BY language")
            .bind(paper_id).bind(i64::from(revision)).fetch_all(&self.pool).await?;
        rows.iter()
            .map(|row| Ok(row.try_get::<Json<PaperTranslation>, _>("content")?.0))
            .collect()
    }

    /// Saves an enrolled job result, with validation, locking, and audit in one transaction.
    ///
    /// # Errors
    /// Rejects missing jobs, stale digests, invalid translations, and database errors.
    pub async fn finish_translation(
        &self,
        paper_id: &str,
        revision: u32,
        language: PaperLanguage,
        result: &TranslationResult,
        actor: &str,
    ) -> Result<(), StorageError> {
        if actor.trim().is_empty() {
            return Err(StorageError::InvalidActor);
        }
        let paper = self.find_revision(paper_id, revision).await?.ok_or(
            StorageError::InvalidTranslation("paper revision does not exist"),
        )?;
        let digest = format!("{:x}", Sha256::digest(paper.source_markdown.as_bytes()));
        let supplied_digest = match result {
            TranslationResult::Completed { translation } => {
                if translation.language != language {
                    return Err(StorageError::InvalidTranslation("language mismatch"));
                }
                validate_translation(
                    &PaperDocument::from_markdown(&paper.source_markdown)?,
                    translation,
                )
                .map_err(StorageError::InvalidTranslation)?;
                &translation.source_sha256
            }
            TranslationResult::Failed { source_sha256 } => source_sha256,
        };
        if *supplied_digest != digest {
            return Err(StorageError::InvalidTranslation("source digest mismatch"));
        }
        let mut tx = self.pool.begin().await?;
        let completed = sqlx::query_scalar::<_, bool>("SELECT completed FROM paper_translation_jobs WHERE paper_id = $1 AND revision = $2 AND language = $3 FOR UPDATE")
            .bind(paper_id).bind(i64::from(revision)).bind(language.as_str()).fetch_optional(&mut *tx).await?
            .ok_or(StorageError::InvalidTranslation("revision was not enrolled for translation"))?;
        if completed {
            tx.commit().await?;
            return Ok(());
        }
        let success = matches!(result, TranslationResult::Completed { .. });
        if let TranslationResult::Completed { translation } = result {
            sqlx::query("INSERT INTO paper_translations (paper_id, revision, language, content, created_by) VALUES ($1, $2, $3, $4, $5)")
                .bind(paper_id).bind(i64::from(revision)).bind(language.as_str()).bind(Json(translation)).bind(actor).execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE paper_translation_jobs SET attempts = attempts + 1, completed = $4 WHERE paper_id = $1 AND revision = $2 AND language = $3")
            .bind(paper_id).bind(i64::from(revision)).bind(language.as_str()).bind(success).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO audit_log (action, actor, paper_id, revision, details) VALUES ($1, $2, $3, $4, $5)")
            .bind(if success { "translation.completed" } else { "translation.failed" }).bind(actor).bind(paper_id).bind(i64::from(revision))
            .bind(Json(serde_json::json!({"language": language, "source_sha256": digest}))).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }
}
