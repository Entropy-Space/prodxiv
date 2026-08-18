use std::{collections::HashSet, fs, path::Path};

use prodxiv_domain::{DraftOwnerKind, DraftReviewStatus, PaperDocument};
use prodxiv_storage::{
    GitHubTrendingLanguageScope, GitHubTrendingLanguageSelector, NewGitHubTrendingSnapshot,
    PostgresStorage, StorageError,
};
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
async fn retains_five_draft_snapshots_and_keeps_delete_audit(pool: PgPool) {
    let storage = PostgresStorage::new(pool.clone());
    let created = storage
        .create_draft(
            "# Working notes\n",
            "integration_test",
            DraftOwnerKind::Author,
        )
        .await
        .expect("draft should be created");
    assert_eq!(created.revision, 1);

    let mut expected_revision = 1;
    for edit in 1..=6 {
        let outcome = storage
            .update_draft(
                &created.paper_uuid,
                expected_revision,
                &format!("# Working notes {edit}\n"),
                "integration_test",
                DraftOwnerKind::Author,
            )
            .await
            .expect("draft should update")
            .expect("draft should still exist");
        assert!(!outcome.replayed);
        expected_revision = outcome.draft.revision;
    }
    assert_eq!(expected_revision, 7);

    let revisions = storage
        .list_draft_revisions(&created.paper_uuid)
        .await
        .expect("draft revisions should be readable")
        .expect("draft should exist");
    assert_eq!(
        revisions
            .iter()
            .map(|revision| revision.revision)
            .collect::<Vec<_>>(),
        vec![7, 6, 5, 4, 3]
    );
    assert!(
        storage
            .find_draft_revision(&created.paper_uuid, 1)
            .await
            .expect("pruned revision lookup should succeed")
            .is_none()
    );

    let conflict = storage
        .update_draft(
            &created.paper_uuid,
            1,
            "# Conflicting edit\n",
            "integration_test",
            DraftOwnerKind::Author,
        )
        .await;
    assert!(matches!(
        conflict,
        Err(StorageError::DraftRevisionConflict {
            current_revision: 7
        })
    ));

    assert!(
        storage
            .delete_draft(
                &created.paper_uuid,
                7,
                "integration_test",
                DraftOwnerKind::Author,
            )
            .await
            .expect("draft should delete")
    );
    assert!(
        storage
            .find_draft(&created.paper_uuid)
            .await
            .expect("deleted draft lookup should succeed")
            .is_none()
    );
    assert!(
        storage
            .list_draft_revisions(&created.paper_uuid)
            .await
            .expect("deleted draft revision list should succeed")
            .is_none()
    );
    let revision_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM paper_draft_revisions WHERE paper_uuid = $1::uuid",
    )
    .bind(&created.paper_uuid)
    .fetch_one(&pool)
    .await
    .expect("draft revision count should be readable");
    assert_eq!(revision_count, 0);
    let audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM paper_draft_audit_log WHERE paper_uuid = $1::uuid",
    )
    .bind(&created.paper_uuid)
    .fetch_one(&pool)
    .await
    .expect("draft audit count should be readable");
    assert_eq!(audit_count, 8);
}

#[sqlx::test(migrations = "../../migrations")]
async fn creates_daily_drafts_idempotently(pool: PgPool) {
    let storage = PostgresStorage::new(pool);
    let first = storage
        .create_draft_idempotent(
            "# Daily draft\n",
            "paperbot_daily",
            DraftOwnerKind::Bot,
            "paperbot-draft-generation-1",
        )
        .await
        .expect("first draft submission should succeed");
    let replay = storage
        .create_draft_idempotent(
            "# Daily draft\n",
            "paperbot_daily",
            DraftOwnerKind::Bot,
            "paperbot-draft-generation-1",
        )
        .await
        .expect("same draft submission should replay");
    assert!(!first.replayed);
    assert!(replay.replayed);
    assert_eq!(replay.draft.paper_uuid, first.draft.paper_uuid);

    let conflict = storage
        .create_draft_idempotent(
            "# Different daily draft\n",
            "paperbot_daily",
            DraftOwnerKind::Bot,
            "paperbot-draft-generation-1",
        )
        .await;
    assert!(matches!(conflict, Err(StorageError::IdempotencyConflict)));
}

#[sqlx::test(migrations = "../../migrations")]
async fn binds_review_decisions_to_one_revision_and_preserves_rejections(pool: PgPool) {
    let storage = PostgresStorage::new(pool.clone());
    let (source, _) = submission();
    let created = storage
        .create_draft(&source, "paperbot_daily", DraftOwnerKind::Bot)
        .await
        .expect("draft should be created");
    assert_eq!(created.review.status, DraftReviewStatus::PendingReview);
    assert_eq!(created.owner_kind, DraftOwnerKind::Bot);

    let unapproved = storage
        .publish_draft(
            &created.paper_uuid,
            created.revision,
            "daily_promoter",
            "draft-review-unapproved",
            None,
        )
        .await;
    assert!(matches!(unapproved, Err(StorageError::DraftNotApproved)));

    let rejected = storage
        .reject_draft(
            &created.paper_uuid,
            created.revision,
            "author_test",
            DraftOwnerKind::Author,
            Some("Not ready for publication"),
        )
        .await
        .expect("rejection should succeed")
        .expect("draft should remain available");
    assert_eq!(rejected.review.status, DraftReviewStatus::Rejected);
    assert_eq!(rejected.review.reviewed_revision, Some(1));
    assert_eq!(
        rejected.review.rejection_reason.as_deref(),
        Some("Not ready for publication")
    );
    assert_eq!(
        storage
            .list_drafts(5, Some(DraftReviewStatus::Rejected), None)
            .await
            .expect("rejected drafts should list")
            .len(),
        1
    );

    let edited = storage
        .update_draft(
            &created.paper_uuid,
            created.revision,
            &source,
            "author_test",
            DraftOwnerKind::Author,
        )
        .await
        .expect("rejected draft should remain editable")
        .expect("draft should exist")
        .draft;
    assert_eq!(edited.revision, 2);
    assert_eq!(edited.owner_kind, DraftOwnerKind::Author);
    assert_eq!(edited.review.status, DraftReviewStatus::PendingReview);
    assert!(edited.review.reviewed_revision.is_none());
    assert!(edited.review.rejection_reason.is_none());

    let bot_edit = storage
        .update_draft(
            &created.paper_uuid,
            edited.revision,
            &source,
            "paperbot_daily",
            DraftOwnerKind::Bot,
        )
        .await;
    assert!(matches!(bot_edit, Err(StorageError::DraftOwnerForbidden)));

    let approved = storage
        .approve_draft(
            &created.paper_uuid,
            edited.revision,
            "author_test",
            DraftOwnerKind::Author,
        )
        .await
        .expect("approval should succeed")
        .expect("draft should exist");
    assert_eq!(approved.review.status, DraftReviewStatus::Approved);
    assert_eq!(approved.review.reviewed_revision, Some(edited.revision));

    let review_actions: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT action
        FROM paper_draft_audit_log
        WHERE paper_uuid = $1::uuid AND action IN ('draft.rejected', 'draft.approved')
        ORDER BY audit_id
        "#,
    )
    .bind(&created.paper_uuid)
    .fetch_all(&pool)
    .await
    .expect("review audit events should be readable");
    assert_eq!(review_actions, ["draft.rejected", "draft.approved"]);
}

#[sqlx::test(migrations = "../../migrations")]
async fn auto_publishes_only_pending_bot_owned_drafts(pool: PgPool) {
    let storage = PostgresStorage::new(pool);
    let (source, _) = submission();
    let author_draft = storage
        .create_draft(&source, "author_test", DraftOwnerKind::Author)
        .await
        .expect("author draft should be created");
    let forbidden = storage
        .approve_and_publish_draft(
            &author_draft.paper_uuid,
            author_draft.revision,
            "paperbot_daily",
            DraftOwnerKind::Bot,
            "draft-auto-publish-author-owned",
            None,
        )
        .await;
    assert!(matches!(forbidden, Err(StorageError::DraftOwnerForbidden)));

    let bot_draft = storage
        .create_draft(&source, "paperbot_daily", DraftOwnerKind::Bot)
        .await
        .expect("bot draft should be created");
    let published = storage
        .approve_and_publish_draft(
            &bot_draft.paper_uuid,
            bot_draft.revision,
            "paperbot_daily",
            DraftOwnerKind::Bot,
            "draft-auto-publish-bot-owned",
            None,
        )
        .await
        .expect("bot-owned publication should succeed")
        .expect("bot-owned draft should exist");
    assert!(!published.replayed);
    assert_eq!(published.paper.revision, 1);
    assert!(
        storage
            .find_draft(&bot_draft.paper_uuid)
            .await
            .expect("published draft lookup should succeed")
            .is_none()
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn publishes_one_exact_draft_revision_and_replays_after_content_deletion(pool: PgPool) {
    let storage = PostgresStorage::new(pool.clone());
    let (source, _) = submission();
    let created = storage
        .create_draft(&source, "integration_test", DraftOwnerKind::Author)
        .await
        .expect("draft should be created");
    storage
        .approve_draft(
            &created.paper_uuid,
            created.revision,
            "author_test",
            DraftOwnerKind::Author,
        )
        .await
        .expect("draft approval should succeed")
        .expect("draft should exist");

    let published = storage
        .publish_draft(
            &created.paper_uuid,
            created.revision,
            "integration_test",
            "draft-publish-request-1",
            None,
        )
        .await
        .expect("draft publication should succeed")
        .expect("draft should exist");
    assert!(!published.replayed);
    assert_eq!(published.paper.revision, 1);
    assert!(
        storage
            .find_draft(&created.paper_uuid)
            .await
            .expect("published draft lookup should succeed")
            .is_none()
    );

    let submitted_markdown: String = sqlx::query_scalar(
        "SELECT submitted_markdown FROM paper_revisions WHERE paper_id = $1 AND revision = 1",
    )
    .bind(&published.paper.paper_id)
    .fetch_one(&pool)
    .await
    .expect("submitted Markdown should be readable");
    assert_eq!(submitted_markdown, source);
    let provenance: (String, i32, String, i32) = sqlx::query_as(
        r#"
        SELECT
          paper_uuid::text,
          draft_revision,
          paper_id,
          paper_revision
        FROM paper_draft_publications
        WHERE paper_uuid = $1::uuid
        "#,
    )
    .bind(&created.paper_uuid)
    .fetch_one(&pool)
    .await
    .expect("draft publication provenance should be readable");
    assert_eq!(provenance.0, created.paper_uuid);
    assert_eq!(provenance.1, 1);
    assert_eq!(provenance.2, published.paper.paper_id);
    assert_eq!(provenance.3, 1);
    let mutated_provenance = sqlx::query(
        "UPDATE paper_draft_publications SET draft_revision = 2 WHERE paper_uuid = $1::uuid",
    )
    .bind(&created.paper_uuid)
    .execute(&pool)
    .await;
    assert!(
        mutated_provenance.is_err(),
        "draft publication provenance must remain immutable"
    );

    let replayed = storage
        .publish_draft(
            &created.paper_uuid,
            created.revision,
            "integration_test",
            "draft-publish-request-1",
            None,
        )
        .await
        .expect("draft publication replay should succeed")
        .expect("idempotency record should survive draft deletion");
    assert!(replayed.replayed);
    assert_eq!(replayed.paper, published.paper);

    let conflicting_replay = storage
        .publish_draft(
            &created.paper_uuid,
            created.revision + 1,
            "integration_test",
            "draft-publish-request-1",
            None,
        )
        .await;
    assert!(matches!(
        conflicting_replay,
        Err(StorageError::IdempotencyConflict)
    ));
}

#[sqlx::test(migrations = "../../migrations")]
async fn keeps_an_invalid_draft_mutable_when_publication_fails(pool: PgPool) {
    let storage = PostgresStorage::new(pool);
    let created = storage
        .create_draft(
            "# Incomplete working notes\n",
            "integration_test",
            DraftOwnerKind::Author,
        )
        .await
        .expect("incomplete draft should be created");

    let result = storage
        .approve_draft(
            &created.paper_uuid,
            created.revision,
            "author_test",
            DraftOwnerKind::Author,
        )
        .await;
    assert!(matches!(result, Err(StorageError::InvalidDraftMarkdown(_))));
    assert!(
        storage
            .find_draft(&created.paper_uuid)
            .await
            .expect("failed draft publication lookup should succeed")
            .is_some()
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn publishes_a_draft_only_once_across_concurrent_request_keys(pool: PgPool) {
    let storage = PostgresStorage::new(pool.clone());
    let (source, _) = submission();
    let created = storage
        .create_draft(&source, "integration_test", DraftOwnerKind::Author)
        .await
        .expect("draft should be created");
    storage
        .approve_draft(
            &created.paper_uuid,
            created.revision,
            "author_test",
            DraftOwnerKind::Author,
        )
        .await
        .expect("draft approval should succeed")
        .expect("draft should exist");

    let (first, second) = tokio::join!(
        storage.publish_draft(
            &created.paper_uuid,
            created.revision,
            "integration_test",
            "draft-publish-concurrent-1",
            None,
        ),
        storage.publish_draft(
            &created.paper_uuid,
            created.revision,
            "integration_test",
            "draft-publish-concurrent-2",
            None,
        )
    );
    let first = first.expect("first concurrent publication should complete");
    let second = second.expect("second concurrent publication should complete");
    match (first, second) {
        (Some(published), None) | (None, Some(published)) => {
            assert!(!published.replayed);
        }
        outcome => panic!("one concurrent publication should win: {outcome:?}"),
    }

    let publication_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM paper_draft_publications")
            .fetch_one(&pool)
            .await
            .expect("draft publication count should be readable");
    assert_eq!(publication_count, 1);
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

    let api_replay = storage
        .ingest_github_trending_snapshot(
            &snapshot,
            "github_actions",
            "github-trending.test.snapshot",
        )
        .await
        .expect("API ingestion should reuse the exact snapshot");
    assert!(!api_replay.inserted);
    assert_eq!(api_replay.snapshot_id, first.snapshot_id);
    let actor: String = sqlx::query_scalar(
        "SELECT actor FROM github_trending_ingestion_requests WHERE idempotency_key = $1",
    )
    .bind("github-trending.test.snapshot")
    .fetch_one(&pool)
    .await
    .expect("ingestion actor should be audited");
    assert_eq!(actor, "github_actions");

    let stored_language: Option<String> =
        sqlx::query_scalar("SELECT language FROM github_trending_snapshots WHERE snapshot_id = $1")
            .bind(first.snapshot_id)
            .fetch_one(&pool)
            .await
            .expect("unfiltered language scope should be readable");
    assert_eq!(stored_language, None, "any remains SQL NULL at rest");

    let mut later_capture = snapshot.clone();
    later_capture.captured_at = Some("2026-07-29T23:59:00Z".to_owned());
    let semantic_replay = storage
        .ingest_github_trending_snapshot(
            &later_capture,
            "github_actions",
            "github-trending.test.snapshot",
        )
        .await
        .expect("capture time alone must not conflict with an idempotent retry");
    assert!(!semantic_replay.inserted);
    assert_eq!(semantic_replay.snapshot_id, first.snapshot_id);

    let mut conflicting = snapshot.clone();
    conflicting.source_revision = "conflicting".to_owned();
    let conflict = storage
        .ingest_github_trending_snapshot(
            &conflicting,
            "github_actions",
            "github-trending.test.snapshot",
        )
        .await;
    assert!(matches!(conflict, Err(StorageError::IdempotencyConflict)));

    let stored = storage
        .latest_github_trending("daily", &GitHubTrendingLanguageScope::Any, None)
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
    rust.language = GitHubTrendingLanguageScope::Language("rust".to_owned());
    rust.source_revision = "rust".to_owned();
    storage
        .import_github_trending_snapshot(&rust)
        .await
        .expect("language snapshot should import");
    let mut empty = snapshot.clone();
    empty.language = GitHubTrendingLanguageScope::Language("raku".to_owned());
    empty.source_revision = "empty-raku".to_owned();
    empty.entries.clear();
    let empty_outcome = storage
        .import_github_trending_snapshot(&empty)
        .await
        .expect("empty language observation should import");
    assert_eq!(empty_outcome.entry_count, 0);

    let view = storage
        .github_trending_view(
            "daily",
            &GitHubTrendingLanguageSelector::Any,
            None,
            Some("2026-07-29"),
        )
        .await
        .expect("Trending navigation should be readable");
    assert_eq!(view.snapshots.len(), 1);
    assert_eq!(view.snapshots[0].language, GitHubTrendingLanguageScope::Any);
    assert_eq!(view.previous_date.as_deref(), Some("2026-07-28"));
    assert_eq!(view.next_date.as_deref(), Some("2026-07-30"));
    assert_eq!(view.available_languages, ["raku", "rust"]);

    let all_view = storage
        .github_trending_view(
            "daily",
            &GitHubTrendingLanguageSelector::All,
            None,
            Some("2026-07-29"),
        )
        .await
        .expect("all Trending scopes should be readable");
    assert_eq!(all_view.snapshots.len(), 3);
    assert_eq!(
        all_view
            .snapshots
            .iter()
            .map(|snapshot| snapshot.language.as_str())
            .collect::<Vec<_>>(),
        ["any", "raku", "rust"]
    );

    let update = sqlx::query("UPDATE github_trending_entries SET rank = 2 WHERE snapshot_id = $1")
        .bind(first.snapshot_id)
        .execute(&pool)
        .await;
    assert!(
        update.is_err(),
        "Trending observations must remain immutable"
    );
}
