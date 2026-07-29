use std::{collections::HashSet, fs, path::Path};

use prodxiv_domain::PaperDocument;
use prodxiv_storage::{NewGitHubTrendingSnapshot, PostgresStorage};
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
    paper.metadata.revision = None;
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

#[sqlx::test]
async fn migrates_existing_publications_to_products_and_revisions(pool: PgPool) {
    sqlx::raw_sql(include_str!(
        "../../../migrations/20260727153000_initial_publishing.sql"
    ))
    .execute(&pool)
    .await
    .expect("initial publishing migration should apply");
    sqlx::raw_sql(include_str!(
        "../../../migrations/20260728090000_publication_idempotency.sql"
    ))
    .execute(&pool)
    .await
    .expect("idempotency migration should apply");

    let metadata = serde_json::json!({
      "schema_version": "1",
      "paper_id": "prodxiv:2607.000001",
      "title": "Existing product paper",
      "summary": "Existing publication",
      "authors": [{ "name": "Existing author" }],
      "published_at": "2026-07-28",
      "version": 1,
      "status": "launched",
      "topics": ["developer_tools"],
      "license": "CC BY 4.0",
      "product_url": "https://example.com",
      "repository_url": "https://github.com/example/product"
    });
    let source_markdown = "---\nversion: 1\n---\n# Summary\n\nExisting source.\n";

    sqlx::query("INSERT INTO papers (paper_id) VALUES ($1)")
        .bind("prodxiv:2607.000001")
        .execute(&pool)
        .await
        .expect("existing paper should insert");
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
        VALUES ($1, 1, '2026-07-28', 'migration_test', $2, $3, $3)
        "#,
    )
    .bind("prodxiv:2607.000001")
    .bind(metadata)
    .bind(source_markdown)
    .execute(&pool)
    .await
    .expect("existing paper version should insert");

    sqlx::raw_sql(include_str!(
        "../../../migrations/20260729120000_product_paper_revisions.sql"
    ))
    .execute(&pool)
    .await
    .expect("product and revision migration should apply");

    let migrated_source: String = sqlx::query_scalar(
        "SELECT source_markdown FROM paper_revisions WHERE paper_id = $1 AND revision = 1",
    )
    .bind("prodxiv:2607.000001")
    .fetch_one(&pool)
    .await
    .expect("migrated source should be readable");
    assert_eq!(migrated_source, source_markdown);

    let product_id: String =
        sqlx::query_scalar("SELECT product_id FROM papers WHERE paper_id = $1")
            .bind("prodxiv:2607.000001")
            .fetch_one(&pool)
            .await
            .expect("paper should reference a product");
    assert_eq!(product_id, "prodxiv-product:2607.000001");

    let resource_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM product_resources WHERE product_id = $1")
            .bind(&product_id)
            .fetch_one(&pool)
            .await
            .expect("backfilled resources should be readable");
    assert_eq!(resource_count, 2);

    let update =
        sqlx::query("UPDATE paper_revisions SET source_markdown = 'changed' WHERE paper_id = $1")
            .bind("prodxiv:2607.000001")
            .execute(&pool)
            .await;
    assert!(update.is_err(), "migrated revisions must remain immutable");
}

#[sqlx::test(migrations = "../../migrations")]
async fn publishes_and_reads_an_immutable_revision(pool: PgPool) {
    let storage = PostgresStorage::new(pool.clone());
    let (source, paper) = submission();

    let published = storage
        .publish_new(
            paper,
            &source,
            "integration_test",
            "paperbot.integration",
            None,
        )
        .await
        .expect("paper should publish")
        .paper;
    assert_eq!(published.revision, 1);
    assert!(published.paper_id.starts_with("prodxiv:"));
    assert!(published.product_id.starts_with("prodxiv-product:"));

    let found = storage
        .find_revision(&published.paper_id, published.revision)
        .await
        .expect("paper should be readable")
        .expect("paper revision should exist");
    assert_eq!(found, published);

    let update = sqlx::query(
        "UPDATE paper_revisions SET source_markdown = 'changed' WHERE paper_id = $1 AND revision = 1",
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

    let repository_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM product_resources WHERE product_id = $1 AND kind = 'repository'",
    )
    .bind(&published.product_id)
    .fetch_one(&pool)
    .await
    .expect("normalized product resources should be readable");
    assert_eq!(repository_count, 1);

    let repository_resource_id: i64 = sqlx::query_scalar(
        "SELECT resource_id FROM product_resources WHERE product_id = $1 AND kind = 'repository'",
    )
    .bind(&published.product_id)
    .fetch_one(&pool)
    .await
    .expect("repository resource should be addressable");
    sqlx::query(
        r#"
        INSERT INTO github_repository_observations (
          resource_id,
          repository_node_id,
          repository_full_name,
          stars
        )
        VALUES ($1, 'R_test', 'example/product', 42)
        "#,
    )
    .bind(repository_resource_id)
    .execute(&pool)
    .await
    .expect("external GitHub observation should insert");
    assert!(
        !published.source_markdown.contains("stars"),
        "external observations must not enter immutable paper source"
    );

    let (second_source, second_paper) = submission();
    let second = storage
        .publish_new(
            second_paper,
            &second_source,
            "integration_test",
            "paperbot.integration.second",
            Some(&published.product_id),
        )
        .await
        .expect("another paper should attach to the existing product")
        .paper;
    assert_eq!(second.product_id, published.product_id);
    assert_ne!(second.paper_id, published.paper_id);
}

#[sqlx::test(migrations = "../../migrations")]
async fn lists_latest_papers_with_stable_cursor_pagination(pool: PgPool) {
    let storage = PostgresStorage::new(pool);
    let mut published_ids = HashSet::new();
    for index in 0..3 {
        let (source, paper) = submission();
        let published = storage
            .publish_new(
                paper,
                &source,
                "listing_test",
                &format!("paperbot.listing.{index}"),
                None,
            )
            .await
            .expect("paper should publish")
            .paper;
        published_ids.insert(published.paper_id);
    }

    let first = storage
        .list_latest(2, None)
        .await
        .expect("first page should load");
    assert_eq!(first.papers.len(), 2);
    let cursor = first
        .next_cursor
        .as_ref()
        .expect("first page should include a cursor");
    let second = storage
        .list_latest(2, Some(cursor))
        .await
        .expect("second page should load");
    assert_eq!(second.papers.len(), 1);
    assert!(second.next_cursor.is_none());

    let listed_ids = first
        .papers
        .iter()
        .chain(&second.papers)
        .map(|paper| paper.paper_id.clone())
        .collect::<HashSet<_>>();
    assert_eq!(listed_ids, published_ids);
}

#[sqlx::test(migrations = "../../migrations")]
async fn allocates_unique_identifiers_under_concurrency(pool: PgPool) {
    let storage = PostgresStorage::new(pool);
    let publications = (0..8)
        .map(|index| {
            let storage = storage.clone();
            let (source, paper) = submission();
            tokio::spawn(async move {
                storage
                    .publish_new(
                        paper,
                        &source,
                        "concurrency_test",
                        &format!("paperbot.concurrent.{index}"),
                        None,
                    )
                    .await
                    .expect("concurrent publication should succeed")
                    .paper
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

#[sqlx::test(migrations = "../../migrations")]
async fn publishes_an_idempotency_key_only_once_under_concurrency(pool: PgPool) {
    let storage = PostgresStorage::new(pool);
    let publications = (0..8)
        .map(|_| {
            let storage = storage.clone();
            let (source, paper) = submission();
            tokio::spawn(async move {
                storage
                    .publish_new(paper, &source, "retry_test", "paperbot.same-request", None)
                    .await
                    .expect("idempotent publication should succeed")
            })
        })
        .collect::<Vec<_>>();

    let mut paper_ids = HashSet::new();
    let mut replay_count = 0;
    for publication in publications {
        let outcome = publication.await.expect("publication task should finish");
        paper_ids.insert(outcome.paper.paper_id);
        replay_count += usize::from(outcome.replayed);
    }
    assert_eq!(paper_ids.len(), 1);
    assert_eq!(replay_count, 7);
}

#[sqlx::test(migrations = "../../migrations")]
async fn imports_and_reads_an_immutable_trending_snapshot(pool: PgPool) {
    let storage = PostgresStorage::new(pool.clone());
    let source =
        fs::read_to_string(repository_root().join("examples/github-trending/2026-07-29.json"))
            .expect("Trending fixture should be readable");
    let snapshot: NewGitHubTrendingSnapshot =
        serde_json::from_str(&source).expect("Trending fixture should parse");

    let first = storage
        .import_github_trending_snapshot(&snapshot)
        .await
        .expect("Trending snapshot should import");
    let replay = storage
        .import_github_trending_snapshot(&snapshot)
        .await
        .expect("re-import should succeed");

    assert!(first.inserted);
    assert!(!replay.inserted);
    assert_eq!(replay.snapshot_id, first.snapshot_id);
    assert_eq!(first.entry_count, 13);

    let stored = storage
        .latest_github_trending("daily", None, None)
        .await
        .expect("Trending snapshot should be readable")
        .expect("Trending snapshot should exist");
    assert_eq!(stored.snapshot_date, "2026-07-29");
    assert_eq!(stored.entries.len(), 13);
    assert_eq!(stored.entries[0].repository_full_name, "pascalorg/editor");

    let mut previous = snapshot.clone();
    previous.snapshot_date = "2026-07-28".to_owned();
    previous.source_revision = "previous".to_owned();
    storage
        .import_github_trending_snapshot(&previous)
        .await
        .expect("previous snapshot should import");
    let mut next = snapshot.clone();
    next.snapshot_date = "2026-07-30".to_owned();
    next.source_revision = "next".to_owned();
    storage
        .import_github_trending_snapshot(&next)
        .await
        .expect("next snapshot should import");
    let mut rust = snapshot.clone();
    rust.language = Some("rust".to_owned());
    rust.source_revision = "rust".to_owned();
    storage
        .import_github_trending_snapshot(&rust)
        .await
        .expect("language snapshot should import");

    let view = storage
        .github_trending_view("daily", None, None, Some("2026-07-29"))
        .await
        .expect("Trending navigation should be readable");
    assert_eq!(view.previous_date.as_deref(), Some("2026-07-28"));
    assert_eq!(view.next_date.as_deref(), Some("2026-07-30"));
    assert_eq!(view.available_languages, ["rust"]);

    let update = sqlx::query("UPDATE github_trending_entries SET rank = 2 WHERE snapshot_id = $1")
        .bind(first.snapshot_id)
        .execute(&pool)
        .await;
    assert!(
        update.is_err(),
        "Trending observations must remain immutable"
    );
}
