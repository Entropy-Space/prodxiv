use std::{collections::HashSet, fs, path::Path};

use prodxiv_domain::PaperDocument;
use prodxiv_storage::PostgresStorage;
use sqlx::PgPool;

fn repository_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("storage crate must be inside the workspace crates directory")
}

fn submission() -> (String, PaperDocument) {
    let source = fs::read_to_string(repository_root().join("examples/papers/prodxiv.md"))
        .expect("exemplary paper should be readable");
    let mut paper = PaperDocument::from_markdown(&source).expect("exemplary paper should parse");
    paper.metadata.paper_id = None;
    paper.metadata.published_at = None;
    paper.metadata.version = None;
    let metadata =
        serde_yaml::to_string(&paper.metadata).expect("submission metadata should serialize");
    let source = format!("---\n{metadata}---\n{}", paper.markdown);
    (source, paper)
}

#[sqlx::test]
async fn serializes_concurrent_migration_runners(pool: PgPool) {
    let first = PostgresStorage::new(pool.clone());
    let second = PostgresStorage::new(pool);

    let (first_result, second_result) = tokio::join!(first.migrate(), second.migrate());

    first_result.expect("first concurrent migrator should succeed");
    second_result.expect("second concurrent migrator should succeed");
}

#[sqlx::test(migrations = "../../migrations")]
async fn publishes_and_reads_an_immutable_version(pool: PgPool) {
    let storage = PostgresStorage::new(pool.clone());
    let (source, paper) = submission();

    let published = storage
        .publish_new(paper, &source, "integration_test")
        .await
        .expect("paper should publish");
    assert_eq!(published.version, 1);
    assert!(published.paper_id.starts_with("prodxiv:"));

    let found = storage
        .find_version(&published.paper_id, published.version)
        .await
        .expect("paper should be readable")
        .expect("paper version should exist");
    assert_eq!(found, published);

    let update = sqlx::query(
        "UPDATE paper_versions SET source_markdown = 'changed' WHERE paper_id = $1 AND version = 1",
    )
    .bind(&published.paper_id)
    .execute(&pool)
    .await;
    assert!(update.is_err(), "published rows must reject updates");

    let audit_count: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE paper_id = $1")
        .bind(&published.paper_id)
        .fetch_one(&pool)
        .await
        .expect("audit record should be readable");
    assert_eq!(audit_count, 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn allocates_unique_identifiers_under_concurrency(pool: PgPool) {
    let storage = PostgresStorage::new(pool);
    let publications = (0..8)
        .map(|_| {
            let storage = storage.clone();
            let (source, paper) = submission();
            tokio::spawn(async move {
                storage
                    .publish_new(paper, &source, "concurrency_test")
                    .await
                    .expect("concurrent publication should succeed")
            })
        })
        .collect::<Vec<_>>();

    let mut paper_ids = HashSet::new();
    for publication in publications {
        let published = publication.await.expect("publication task should finish");
        assert!(paper_ids.insert(published.paper_id));
    }
    assert_eq!(paper_ids.len(), 8);
}
