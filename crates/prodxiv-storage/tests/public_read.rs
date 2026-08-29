use prodxiv_domain::{
    DraftOwnerKind, PaperDocument, PublicPaperDraftResponse, PublicationIdentity,
    encode_paper_id_suffix, prepare_publication,
};
use prodxiv_storage::{PostgresStorage, PublicationFilter, StorageError};
use sqlx::PgPool;

fn submission() -> String {
    let mut paper =
        PaperDocument::from_markdown(include_str!("../../../examples/papers/prodxiv.md"))
            .expect("fixture parses");
    paper.metadata.paper_id = None;
    paper.metadata.revision = None;
    paper.metadata.published_at = None;
    format!(
        "---\n{}---\n{}",
        serde_yaml::to_string(&paper.metadata).unwrap(),
        paper.markdown
    )
}

#[sqlx::test(migrations = "../../migrations")]
async fn public_reads_project_only_current_pending_content(pool: PgPool) {
    let storage = PostgresStorage::new(pool);
    let valid = storage
        .create_draft(&submission(), "bot", DraftOwnerKind::Bot)
        .await
        .unwrap();
    let malformed = storage
        .create_draft("---\ntitle: [broken\n---\nBody", "bot", DraftOwnerKind::Bot)
        .await
        .unwrap();
    let approved = storage
        .create_draft(&submission(), "author", DraftOwnerKind::Author)
        .await
        .unwrap();
    let rejected = storage
        .create_draft(&submission(), "author", DraftOwnerKind::Author)
        .await
        .unwrap();
    storage
        .approve_draft(
            &approved.paper_uuid,
            1,
            "private-author",
            DraftOwnerKind::Author,
        )
        .await
        .unwrap();
    storage
        .reject_draft(
            &rejected.paper_uuid,
            1,
            "private-author",
            DraftOwnerKind::Author,
            Some("private review notes"),
        )
        .await
        .unwrap();

    let page = storage.list_public_drafts(100, None).await.unwrap();
    assert_eq!(page.drafts.len(), 2);
    assert!(
        page.drafts
            .iter()
            .find(|draft| draft.paper_uuid == valid.paper_uuid)
            .unwrap()
            .metadata
            .is_some()
    );
    assert!(
        page.drafts
            .iter()
            .find(|draft| draft.paper_uuid == malformed.paper_uuid)
            .unwrap()
            .metadata
            .is_none()
    );
    let serialized = serde_json::to_string(&page.drafts).unwrap();
    assert!(!serialized.contains("private-author"));
    assert!(!serialized.contains("private review notes"));
    assert!(!serialized.contains("source_markdown"));
    for paper_uuid in [
        &approved.paper_uuid,
        &rejected.paper_uuid,
        "00000000-0000-4000-8000-000000000000",
    ] {
        assert!(
            storage
                .find_public_draft(paper_uuid)
                .await
                .unwrap()
                .is_none()
        );
    }

    storage
        .update_draft(
            &valid.paper_uuid,
            1,
            "# Current author source",
            "author",
            DraftOwnerKind::Author,
        )
        .await
        .unwrap();
    let Some(PublicPaperDraftResponse::Draft { draft }) =
        storage.find_public_draft(&valid.paper_uuid).await.unwrap()
    else {
        panic!("current draft should be readable")
    };
    assert_eq!(draft.revision, 2);
    assert_eq!(draft.owner_kind, DraftOwnerKind::Author);
    assert_eq!(draft.source_markdown, "# Current author source");
    assert!(draft.metadata.is_none());
    assert!(
        storage
            .find_draft_revision(&valid.paper_uuid, 1)
            .await
            .unwrap()
            .is_some(),
        "management history remains available privately"
    );
    assert!(matches!(
        storage
            .approve_and_publish_draft(
                &valid.paper_uuid,
                2,
                "bot",
                DraftOwnerKind::Bot,
                "public-owner-guard",
                None
            )
            .await,
        Err(StorageError::DraftOwnerForbidden)
    ));
}

#[sqlx::test(migrations = "../../migrations")]
async fn public_draft_keysets_handle_equal_edit_timestamps_and_concurrent_new_entries(
    pool: PgPool,
) {
    let storage = PostgresStorage::new(pool.clone());
    let mut expected = Vec::new();
    for index in 0..3 {
        expected.push(
            storage
                .create_draft(&format!("# Draft {index}"), "bot", DraftOwnerKind::Bot)
                .await
                .unwrap()
                .paper_uuid,
        );
    }
    sqlx::query("UPDATE paper_drafts SET updated_at = '2026-08-28 12:00:00.123456Z'")
        .execute(&pool)
        .await
        .unwrap();
    expected.sort_by(|left, right| right.cmp(left));
    let first = storage.list_public_drafts(1, None).await.unwrap();
    assert_eq!(first.drafts[0].paper_uuid, expected[0]);
    let cursor = first.next_cursor.as_ref().unwrap();
    assert_eq!(cursor.updated_at_micros % 1_000_000, 123_456);
    let newer = storage
        .create_draft("# New draft", "bot", DraftOwnerKind::Bot)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE paper_drafts SET updated_at = '2026-08-28 13:00:00Z' WHERE paper_uuid = $1::uuid",
    )
    .bind(&newer.paper_uuid)
    .execute(&pool)
    .await
    .unwrap();
    let next = storage.list_public_drafts(1, Some(cursor)).await.unwrap();
    assert_eq!(next.drafts[0].paper_uuid, expected[1]);
    let last = storage
        .list_public_drafts(1, next.next_cursor.as_ref())
        .await
        .unwrap();
    assert_eq!(last.drafts[0].paper_uuid, expected[2]);
    assert!(last.next_cursor.is_none());
}

#[sqlx::test(migrations = "../../migrations")]
async fn publication_mapping_survives_draft_removal_but_deleted_drafts_do_not_resolve(
    pool: PgPool,
) {
    let storage = PostgresStorage::new(pool);
    let draft = storage
        .create_draft(&submission(), "bot", DraftOwnerKind::Bot)
        .await
        .unwrap();
    let publication = storage
        .approve_and_publish_draft(
            &draft.paper_uuid,
            1,
            "bot",
            DraftOwnerKind::Bot,
            "public-promotion",
            None,
        )
        .await
        .unwrap()
        .unwrap()
        .paper;
    assert!(
        storage
            .find_draft(&draft.paper_uuid)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        storage.find_public_draft(&draft.paper_uuid).await.unwrap(),
        Some(PublicPaperDraftResponse::Published {
            paper_id: publication.paper_id,
            revision: publication.revision,
        })
    );
    assert!(
        storage
            .list_public_drafts(100, None)
            .await
            .unwrap()
            .drafts
            .is_empty()
    );
    let deleted = storage
        .create_draft("# Deleted private draft", "author", DraftOwnerKind::Author)
        .await
        .unwrap();
    storage
        .delete_draft(&deleted.paper_uuid, 1, "author", DraftOwnerKind::Author)
        .await
        .unwrap();
    assert!(
        storage
            .find_public_draft(&deleted.paper_uuid)
            .await
            .unwrap()
            .is_none()
    );
}

async fn insert_revision(
    pool: &PgPool,
    id: u32,
    revision: u32,
    title: &str,
    topic: &str,
    time_offset: i64,
) -> String {
    let paper_id = format!("prodxiv:2608.{}", encode_paper_id_suffix(id).unwrap());
    let product_id = "prodxiv-product:2608.000001";
    let mut paper = PaperDocument::from_markdown(&submission()).unwrap();
    paper.metadata.title = title.to_owned();
    paper.metadata.topics = vec![topic.to_owned()];
    let published = prepare_publication(
        paper,
        PublicationIdentity {
            paper_id: paper_id.clone(),
            revision,
            published_at: "2026-08-28".to_owned(),
        },
        product_id.to_owned(),
    )
    .unwrap();
    sqlx::query("INSERT INTO products (product_id, initial_name) VALUES ($1, 'Archive fixtures') ON CONFLICT DO NOTHING")
        .bind(product_id).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO papers (paper_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(&paper_id)
        .bind(product_id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO paper_revisions (paper_id, revision, published_at, published_by, metadata, submitted_markdown, source_markdown, created_at) VALUES ($1, $2, '2026-08-28', 'test', $3, $4, $4, '2026-08-28 12:00:00Z'::timestamptz + $5 * INTERVAL '1 second')"
    ).bind(&paper_id).bind(i32::try_from(revision).unwrap()).bind(sqlx::types::Json(published.metadata))
        .bind(published.source_markdown).bind(time_offset).execute(pool).await.unwrap();
    paper_id
}

#[sqlx::test(migrations = "../../migrations")]
async fn archive_filters_latest_revisions_in_sql_before_stable_pagination(pool: PgPool) {
    let storage = PostgresStorage::new(pool.clone());
    let paper_id = insert_revision(&pool, 1, 1, "Superseded searchterm", "old_topic", 1).await;
    insert_revision(&pool, 1, 3, "Current archive", "current_topic", 2).await;
    let one = insert_revision(&pool, 2, 1, "Needle One", "matching_topic", 3).await;
    let two = insert_revision(&pool, 3, 1, "Needle Two", "matching_topic", 3).await;
    for id in 4..108 {
        insert_revision(&pool, id, 1, "Unrelated", "other_topic", i64::from(id)).await;
    }
    let filter = PublicationFilter {
        q: Some("NEEDLE".to_owned()),
        topic: Some("matching_topic".to_owned()),
    };
    let first = storage.search_latest(1, None, &filter).await.unwrap();
    assert_eq!(first.papers[0].paper_id, two);
    let second = storage
        .search_latest(1, first.next_cursor.as_ref(), &filter)
        .await
        .unwrap();
    assert_eq!(second.papers[0].paper_id, one);
    assert!(second.next_cursor.is_none());
    for filter in [
        PublicationFilter {
            q: Some("Superseded".to_owned()),
            topic: None,
        },
        PublicationFilter {
            q: None,
            topic: Some("old_topic".to_owned()),
        },
        PublicationFilter {
            q: Some("needle".to_owned()),
            topic: Some("current_topic".to_owned()),
        },
        PublicationFilter {
            q: Some("%".to_owned()),
            topic: None,
        },
    ] {
        assert!(
            storage
                .search_latest(100, None, &filter)
                .await
                .unwrap()
                .papers
                .is_empty()
        );
    }
    assert_eq!(
        storage.list_paper_topics().await.unwrap(),
        ["current_topic", "matching_topic", "other_topic"]
    );
    let revisions = storage.list_paper_revisions(&paper_id).await.unwrap();
    assert_eq!(
        revisions
            .iter()
            .map(|paper| paper.revision)
            .collect::<Vec<_>>(),
        [3, 1]
    );
    assert_eq!(revisions[1].metadata.title, "Superseded searchterm");
    assert!(
        storage
            .list_paper_revisions("prodxiv:2608.ZZZZZZ")
            .await
            .unwrap()
            .is_empty()
    );
    let exact = storage.find_revision(&paper_id, 1).await.unwrap().unwrap();
    assert_eq!(exact.metadata, revisions[1].metadata);
    assert!(exact.source_markdown.contains("Superseded searchterm"));
    let unfiltered = storage.list_latest(100, None).await.unwrap();
    assert!(
        unfiltered.next_cursor.is_some(),
        "legacy unfiltered pagination still works"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn archive_keeps_historically_accepted_topic_slugs_filterable(pool: PgPool) {
    let storage = PostgresStorage::new(pool.clone());
    let paper_id = insert_revision(
        &pool,
        1,
        1,
        "Historical topic spelling",
        "developer__tools",
        1,
    )
    .await;
    let page = storage
        .search_latest(
            20,
            None,
            &PublicationFilter {
                q: None,
                topic: Some("developer__tools".to_owned()),
            },
        )
        .await
        .unwrap();
    assert_eq!(page.papers.len(), 1);
    assert_eq!(page.papers[0].paper_id, paper_id);
    assert_eq!(page.papers[0].metadata.topics, ["developer__tools"]);
    assert_eq!(
        storage.list_paper_topics().await.unwrap(),
        ["developer__tools"]
    );
}
