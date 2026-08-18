use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use prodxiv_api::{
    AppState, GitHubActionsWorkload, GitHubOidcAuthenticationError, GitHubOidcAuthenticator,
    PublicationStore, StoreError, router,
};
use prodxiv_domain::{
    DRAFT_REVISION_RETENTION, DraftOwnerKind, DraftReviewStatus, PaperDocument, PaperDraft,
    PaperDraftReview, PaperDraftRevision, PaperDraftRevisionSummary, PaperDraftSummary,
    PaperStatus, ProductStatus, PublicationIdentity, PublicationPreparationError, PublishedPaper,
    PublishedPaperSummary, prepare_publication,
};
use prodxiv_storage::{
    DraftCreateOutcome, DraftUpdateOutcome, GitHubTrendingEntry, GitHubTrendingLanguageScope,
    GitHubTrendingLanguageSelector, GitHubTrendingSnapshot, GitHubTrendingView,
    NewGitHubTrendingSnapshot, PublicationCursor, PublicationPage, PublishOutcome,
    TrendingImportOutcome,
};
use serde_json::{Value, json};
use tower::ServiceExt;

const TOKEN: &str = "test_token_with_at_least_32_characters";
const BOT_TOKEN: &str = "bot_token_with_at_least_32_characters";
const INGEST_TOKEN: &str = "trending_ingest_token_with_32_characters";
const PAPERBOT_OIDC_TOKEN: &str = "paperbot.oidc.token";
const TRENDING_OIDC_TOKEN: &str = "trending.oidc.token";

struct FakeGitHubOidcAuthenticator;

#[async_trait]
impl GitHubOidcAuthenticator for FakeGitHubOidcAuthenticator {
    async fn authenticate(
        &self,
        token: &str,
        workload: GitHubActionsWorkload,
    ) -> Result<(), GitHubOidcAuthenticationError> {
        let accepted = matches!(
            (token, workload),
            (PAPERBOT_OIDC_TOKEN, GitHubActionsWorkload::Paperbot)
                | (TRENDING_OIDC_TOKEN, GitHubActionsWorkload::Trending)
        );
        if accepted {
            Ok(())
        } else {
            Err(GitHubOidcAuthenticationError::InvalidToken)
        }
    }
}

#[derive(Default)]
struct FakeStore {
    drafts: Mutex<HashMap<String, Vec<PaperDraftRevision>>>,
    draft_owners: Mutex<HashMap<String, DraftOwnerKind>>,
    draft_reviews: Mutex<HashMap<String, PaperDraftReview>>,
    draft_requests: Mutex<HashMap<String, (String, String)>>,
    publications: Mutex<Vec<PublishedPaper>>,
    requests: Mutex<HashMap<String, (String, PublishedPaper)>>,
    trending_requests: Mutex<HashMap<String, String>>,
    trending_actors: Mutex<Vec<String>>,
    github_trending: Mutex<Vec<GitHubTrendingSnapshot>>,
}

#[async_trait]
impl PublicationStore for FakeStore {
    async fn create_draft(
        &self,
        source_markdown: &str,
        _actor: &str,
        owner_kind: DraftOwnerKind,
        idempotency_key: &str,
    ) -> Result<DraftCreateOutcome, StoreError> {
        let existing = self
            .draft_requests
            .lock()
            .expect("fake draft requests should lock")
            .get(idempotency_key)
            .cloned();
        if let Some((existing_source, paper_uuid)) = existing {
            if existing_source != source_markdown {
                return Err(StoreError::IdempotencyConflict);
            }
            let draft = self
                .find_draft(&paper_uuid)
                .await?
                .ok_or(StoreError::DraftCreationCompleted)?;
            return Ok(DraftCreateOutcome {
                draft,
                replayed: true,
            });
        }
        let mut drafts = self.drafts.lock().expect("fake drafts should lock");
        let paper_uuid = format!(
            "00000000-0000-4000-8000-{:012x}",
            drafts.len().saturating_add(1)
        );
        let created_at = "2026-08-15T00:00:00.000000Z".to_owned();
        let revision = PaperDraftRevision {
            paper_uuid: paper_uuid.clone(),
            revision: 1,
            source_markdown: source_markdown.to_owned(),
            created_at: created_at.clone(),
        };
        drafts.insert(paper_uuid.clone(), vec![revision]);
        self.draft_owners
            .lock()
            .expect("fake draft owners should lock")
            .insert(paper_uuid.clone(), owner_kind);
        let review = PaperDraftReview::pending();
        self.draft_reviews
            .lock()
            .expect("fake draft reviews should lock")
            .insert(paper_uuid.clone(), review.clone());
        let draft = PaperDraft {
            paper_uuid,
            revision: 1,
            owner_kind,
            source_markdown: source_markdown.to_owned(),
            review,
            created_at: created_at.clone(),
            updated_at: created_at,
        };
        self.draft_requests
            .lock()
            .expect("fake draft requests should lock")
            .insert(
                idempotency_key.to_owned(),
                (source_markdown.to_owned(), draft.paper_uuid.clone()),
            );
        Ok(DraftCreateOutcome {
            draft,
            replayed: false,
        })
    }

    async fn list_drafts(
        &self,
        limit: u32,
        review_status: Option<DraftReviewStatus>,
        owner_kind: Option<DraftOwnerKind>,
    ) -> Result<Vec<PaperDraftSummary>, StoreError> {
        let drafts = self.drafts.lock().expect("fake drafts should lock");
        let reviews = self
            .draft_reviews
            .lock()
            .expect("fake draft reviews should lock");
        let owners = self
            .draft_owners
            .lock()
            .expect("fake draft owners should lock");
        Ok(drafts
            .values()
            .filter_map(|revisions| revisions.last())
            .filter(|revision| {
                review_status.is_none_or(|status| {
                    reviews
                        .get(&revision.paper_uuid)
                        .is_some_and(|review| review.status == status)
                })
            })
            .filter(|revision| {
                owner_kind.is_none_or(|kind| owners.get(&revision.paper_uuid) == Some(&kind))
            })
            .take(usize::try_from(limit).expect("u32 fits in usize"))
            .map(|revision| PaperDraftSummary {
                paper_uuid: revision.paper_uuid.clone(),
                revision: revision.revision,
                owner_kind: *owners
                    .get(&revision.paper_uuid)
                    .expect("fake draft owner exists"),
                review: reviews
                    .get(&revision.paper_uuid)
                    .cloned()
                    .expect("fake draft review exists"),
                created_at: "2026-08-15T00:00:00.000000Z".to_owned(),
                updated_at: revision.created_at.clone(),
            })
            .collect())
    }

    async fn find_draft(&self, paper_uuid: &str) -> Result<Option<PaperDraft>, StoreError> {
        let drafts = self.drafts.lock().expect("fake drafts should lock");
        let reviews = self
            .draft_reviews
            .lock()
            .expect("fake draft reviews should lock");
        let owners = self
            .draft_owners
            .lock()
            .expect("fake draft owners should lock");
        Ok(drafts.get(paper_uuid).and_then(|revisions| {
            revisions.last().map(|revision| PaperDraft {
                paper_uuid: revision.paper_uuid.clone(),
                revision: revision.revision,
                owner_kind: *owners.get(paper_uuid).expect("fake draft owner exists"),
                source_markdown: revision.source_markdown.clone(),
                review: reviews
                    .get(paper_uuid)
                    .cloned()
                    .expect("fake draft review exists"),
                created_at: "2026-08-15T00:00:00.000000Z".to_owned(),
                updated_at: revision.created_at.clone(),
            })
        }))
    }

    async fn update_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        source_markdown: &str,
        _actor: &str,
        actor_kind: DraftOwnerKind,
    ) -> Result<Option<DraftUpdateOutcome>, StoreError> {
        let mut drafts = self.drafts.lock().expect("fake drafts should lock");
        let Some(revisions) = drafts.get_mut(paper_uuid) else {
            return Ok(None);
        };
        if actor_kind == DraftOwnerKind::Bot
            && self
                .draft_owners
                .lock()
                .expect("fake draft owners should lock")
                .get(paper_uuid)
                != Some(&DraftOwnerKind::Bot)
        {
            return Err(StoreError::DraftOwnerForbidden);
        }
        let current = revisions.last().expect("draft has a revision");
        if current.revision != expected_revision {
            if current.revision == expected_revision.saturating_add(1)
                && current.source_markdown == source_markdown
            {
                return Ok(Some(DraftUpdateOutcome {
                    draft: PaperDraft {
                        paper_uuid: current.paper_uuid.clone(),
                        revision: current.revision,
                        owner_kind: *self
                            .draft_owners
                            .lock()
                            .expect("fake draft owners should lock")
                            .get(paper_uuid)
                            .expect("fake draft owner exists"),
                        source_markdown: current.source_markdown.clone(),
                        review: self
                            .draft_reviews
                            .lock()
                            .expect("fake draft reviews should lock")
                            .get(paper_uuid)
                            .cloned()
                            .expect("fake draft review exists"),
                        created_at: "2026-08-15T00:00:00.000000Z".to_owned(),
                        updated_at: current.created_at.clone(),
                    },
                    replayed: true,
                }));
            }
            return Err(StoreError::DraftRevisionConflict {
                current_revision: current.revision,
            });
        }
        let revision_number = current.revision + 1;
        let created_at = format!("2026-08-15T00:00:{revision_number:02}.000000Z");
        let revision = PaperDraftRevision {
            paper_uuid: paper_uuid.to_owned(),
            revision: revision_number,
            source_markdown: source_markdown.to_owned(),
            created_at: created_at.clone(),
        };
        revisions.push(revision);
        if revisions.len() > usize::try_from(DRAFT_REVISION_RETENTION).expect("retention fits") {
            revisions.remove(0);
        }
        self.draft_reviews
            .lock()
            .expect("fake draft reviews should lock")
            .insert(paper_uuid.to_owned(), PaperDraftReview::pending());
        let mut owners = self
            .draft_owners
            .lock()
            .expect("fake draft owners should lock");
        let owner_kind = owners.get_mut(paper_uuid).expect("fake draft owner exists");
        if actor_kind == DraftOwnerKind::Author {
            *owner_kind = DraftOwnerKind::Author;
        }
        let owner_kind = *owner_kind;
        Ok(Some(DraftUpdateOutcome {
            draft: PaperDraft {
                paper_uuid: paper_uuid.to_owned(),
                revision: revision_number,
                owner_kind,
                source_markdown: source_markdown.to_owned(),
                review: PaperDraftReview::pending(),
                created_at: "2026-08-15T00:00:00.000000Z".to_owned(),
                updated_at: created_at,
            },
            replayed: false,
        }))
    }

    async fn approve_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        _actor: &str,
        actor_kind: DraftOwnerKind,
    ) -> Result<Option<PaperDraft>, StoreError> {
        if actor_kind == DraftOwnerKind::Bot {
            return Err(StoreError::DraftOwnerForbidden);
        }
        let draft = self.find_draft(paper_uuid).await?;
        let Some(mut draft) = draft else {
            return Ok(None);
        };
        if draft.revision != expected_revision {
            return Err(StoreError::DraftRevisionConflict {
                current_revision: draft.revision,
            });
        }
        let paper = PaperDocument::from_markdown(&draft.source_markdown)
            .map_err(|error| StoreError::InvalidDraftMarkdown(error.to_string()))?;
        prepare_publication(
            paper,
            PublicationIdentity {
                paper_id: "prodxiv:2607.000001".to_owned(),
                revision: 1,
                published_at: "2026-07-27".to_owned(),
            },
            "prodxiv-product:2607.000001".to_owned(),
        )
        .map_err(|error| match error {
            PublicationPreparationError::Invalid(report) => StoreError::InvalidPublication(report),
            PublicationPreparationError::Serialize(_) => StoreError::Internal,
        })?;
        let review = PaperDraftReview {
            status: DraftReviewStatus::Approved,
            reviewed_revision: Some(expected_revision),
            reviewed_by: Some("test_actor".to_owned()),
            reviewed_at: Some("2026-08-15T00:01:00.000000Z".to_owned()),
            rejection_reason: None,
        };
        self.draft_reviews
            .lock()
            .expect("fake draft reviews should lock")
            .insert(paper_uuid.to_owned(), review.clone());
        draft.review = review;
        Ok(Some(draft))
    }

    async fn reject_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        _actor: &str,
        actor_kind: DraftOwnerKind,
        reason: Option<&str>,
    ) -> Result<Option<PaperDraft>, StoreError> {
        let draft = self.find_draft(paper_uuid).await?;
        let Some(mut draft) = draft else {
            return Ok(None);
        };
        if actor_kind == DraftOwnerKind::Bot && draft.owner_kind != DraftOwnerKind::Bot {
            return Err(StoreError::DraftOwnerForbidden);
        }
        if draft.revision != expected_revision {
            return Err(StoreError::DraftRevisionConflict {
                current_revision: draft.revision,
            });
        }
        let review = PaperDraftReview {
            status: DraftReviewStatus::Rejected,
            reviewed_revision: Some(expected_revision),
            reviewed_by: Some("test_actor".to_owned()),
            reviewed_at: Some("2026-08-15T00:01:00.000000Z".to_owned()),
            rejection_reason: reason.map(str::to_owned),
        };
        self.draft_reviews
            .lock()
            .expect("fake draft reviews should lock")
            .insert(paper_uuid.to_owned(), review.clone());
        draft.review = review;
        Ok(Some(draft))
    }

    async fn list_draft_revisions(
        &self,
        paper_uuid: &str,
    ) -> Result<Option<Vec<PaperDraftRevisionSummary>>, StoreError> {
        let drafts = self.drafts.lock().expect("fake drafts should lock");
        Ok(drafts.get(paper_uuid).map(|revisions| {
            revisions
                .iter()
                .rev()
                .map(PaperDraftRevisionSummary::from)
                .collect()
        }))
    }

    async fn find_draft_revision(
        &self,
        paper_uuid: &str,
        revision: u32,
    ) -> Result<Option<PaperDraftRevision>, StoreError> {
        let drafts = self.drafts.lock().expect("fake drafts should lock");
        Ok(drafts
            .get(paper_uuid)
            .and_then(|revisions| {
                revisions
                    .iter()
                    .find(|candidate| candidate.revision == revision)
            })
            .cloned())
    }

    async fn delete_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        _actor: &str,
        actor_kind: DraftOwnerKind,
    ) -> Result<bool, StoreError> {
        let mut drafts = self.drafts.lock().expect("fake drafts should lock");
        let Some(current_revision) = drafts
            .get(paper_uuid)
            .and_then(|revisions| revisions.last())
            .map(|revision| revision.revision)
        else {
            return Ok(false);
        };
        if current_revision != expected_revision {
            return Err(StoreError::DraftRevisionConflict { current_revision });
        }
        if actor_kind == DraftOwnerKind::Bot
            && self
                .draft_owners
                .lock()
                .expect("fake draft owners should lock")
                .get(paper_uuid)
                != Some(&DraftOwnerKind::Bot)
        {
            return Err(StoreError::DraftOwnerForbidden);
        }
        drafts.remove(paper_uuid);
        self.draft_owners
            .lock()
            .expect("fake draft owners should lock")
            .remove(paper_uuid);
        self.draft_reviews
            .lock()
            .expect("fake draft reviews should lock")
            .remove(paper_uuid);
        Ok(true)
    }

    async fn publish_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        _actor: &str,
        idempotency_key: &str,
        product_id: Option<&str>,
    ) -> Result<Option<PublishOutcome>, StoreError> {
        let semantic_request = format!(
            "draft:{paper_uuid}:{expected_revision}:{}",
            product_id.unwrap_or_default()
        );
        if let Some((existing_request, published)) = self
            .requests
            .lock()
            .expect("fake requests should lock")
            .get(idempotency_key)
        {
            if existing_request != &semantic_request {
                return Err(StoreError::IdempotencyConflict);
            }
            return Ok(Some(PublishOutcome {
                paper: published.clone(),
                replayed: true,
            }));
        }

        let source_markdown = {
            let drafts = self.drafts.lock().expect("fake drafts should lock");
            let Some(current) = drafts
                .get(paper_uuid)
                .and_then(|revisions| revisions.last())
            else {
                return Ok(None);
            };
            if current.revision != expected_revision {
                return Err(StoreError::DraftRevisionConflict {
                    current_revision: current.revision,
                });
            }
            let approved = self
                .draft_reviews
                .lock()
                .expect("fake draft reviews should lock")
                .get(paper_uuid)
                .is_some_and(|review| {
                    review.status == DraftReviewStatus::Approved
                        && review.reviewed_revision == Some(expected_revision)
                });
            if !approved {
                return Err(StoreError::DraftNotApproved);
            }
            current.source_markdown.clone()
        };
        let paper = PaperDocument::from_markdown(&source_markdown)
            .map_err(|error| StoreError::InvalidDraftMarkdown(error.to_string()))?;
        let published = prepare_publication(
            paper,
            PublicationIdentity {
                paper_id: "prodxiv:2607.000001".to_owned(),
                revision: 1,
                published_at: "2026-07-27".to_owned(),
            },
            product_id
                .unwrap_or("prodxiv-product:2607.000001")
                .to_owned(),
        )
        .map_err(|error| match error {
            PublicationPreparationError::Invalid(report) => StoreError::InvalidPublication(report),
            PublicationPreparationError::Serialize(_) => StoreError::Internal,
        })?;

        self.drafts
            .lock()
            .expect("fake drafts should lock")
            .remove(paper_uuid);
        self.draft_owners
            .lock()
            .expect("fake draft owners should lock")
            .remove(paper_uuid);
        self.draft_reviews
            .lock()
            .expect("fake draft reviews should lock")
            .remove(paper_uuid);
        self.publications
            .lock()
            .expect("fake store should lock")
            .push(published.clone());
        self.requests
            .lock()
            .expect("fake requests should lock")
            .insert(
                idempotency_key.to_owned(),
                (semantic_request, published.clone()),
            );
        Ok(Some(PublishOutcome {
            paper: published,
            replayed: false,
        }))
    }

    async fn approve_and_publish_draft(
        &self,
        paper_uuid: &str,
        expected_revision: u32,
        actor: &str,
        actor_kind: DraftOwnerKind,
        idempotency_key: &str,
        product_id: Option<&str>,
    ) -> Result<Option<PublishOutcome>, StoreError> {
        match self
            .publish_draft(
                paper_uuid,
                expected_revision,
                actor,
                idempotency_key,
                product_id,
            )
            .await
        {
            Ok(outcome) => return Ok(outcome),
            Err(StoreError::DraftNotApproved) => {}
            Err(error) => return Err(error),
        }
        let draft = self.find_draft(paper_uuid).await?;
        let Some(draft) = draft else {
            return Ok(None);
        };
        if actor_kind == DraftOwnerKind::Bot
            && (draft.owner_kind != DraftOwnerKind::Bot
                || draft.review.status != DraftReviewStatus::PendingReview)
        {
            return Err(StoreError::DraftOwnerForbidden);
        }
        self.draft_reviews
            .lock()
            .expect("fake draft reviews should lock")
            .insert(
                paper_uuid.to_owned(),
                PaperDraftReview {
                    status: DraftReviewStatus::Approved,
                    reviewed_revision: Some(expected_revision),
                    reviewed_by: Some(actor.to_owned()),
                    reviewed_at: Some("2026-08-15T00:01:00.000000Z".to_owned()),
                    rejection_reason: None,
                },
            );
        self.publish_draft(
            paper_uuid,
            expected_revision,
            actor,
            idempotency_key,
            product_id,
        )
        .await
    }

    async fn publish_new(
        &self,
        paper: PaperDocument,
        submitted_markdown: &str,
        _actor: &str,
        idempotency_key: &str,
        product_id: Option<&str>,
    ) -> Result<PublishOutcome, StoreError> {
        if let Some((existing_source, published)) = self
            .requests
            .lock()
            .expect("fake requests should lock")
            .get(idempotency_key)
        {
            if existing_source != submitted_markdown {
                return Err(StoreError::IdempotencyConflict);
            }
            return Ok(PublishOutcome {
                paper: published.clone(),
                replayed: true,
            });
        }
        let published = prepare_publication(
            paper,
            PublicationIdentity {
                paper_id: "prodxiv:2607.000001".to_owned(),
                revision: 1,
                published_at: "2026-07-27".to_owned(),
            },
            product_id
                .unwrap_or("prodxiv-product:2607.000001")
                .to_owned(),
        )
        .expect("valid test submission should publish");
        self.publications
            .lock()
            .expect("fake store should lock")
            .push(published.clone());
        self.requests
            .lock()
            .expect("fake requests should lock")
            .insert(
                idempotency_key.to_owned(),
                (submitted_markdown.to_owned(), published.clone()),
            );
        Ok(PublishOutcome {
            paper: published,
            replayed: false,
        })
    }

    async fn find_revision(
        &self,
        paper_id: &str,
        revision: u32,
    ) -> Result<Option<PublishedPaper>, StoreError> {
        Ok(self
            .publications
            .lock()
            .expect("fake store should lock")
            .iter()
            .find(|paper| paper.paper_id == paper_id && paper.revision == revision)
            .cloned())
    }

    async fn list_latest(
        &self,
        limit: u32,
        cursor: Option<&PublicationCursor>,
    ) -> Result<PublicationPage, StoreError> {
        let publications = self
            .publications
            .lock()
            .expect("fake store should lock")
            .clone();
        let mut entries = publications
            .iter()
            .enumerate()
            .map(|(index, paper)| {
                (
                    PublishedPaperSummary::from(paper),
                    PublicationCursor {
                        created_at_micros: i64::try_from(index + 1)
                            .expect("test publication count fits in i64"),
                        paper_id: paper.paper_id.clone(),
                    },
                )
            })
            .filter(|(_, item_cursor)| {
                cursor.is_none_or(|cursor| {
                    (item_cursor.created_at_micros, &item_cursor.paper_id)
                        < (cursor.created_at_micros, &cursor.paper_id)
                })
            })
            .collect::<Vec<_>>();
        entries.sort_by(|(_, left), (_, right)| {
            (right.created_at_micros, &right.paper_id)
                .cmp(&(left.created_at_micros, &left.paper_id))
        });
        let limit = usize::try_from(limit).expect("u32 fits in usize");
        let has_more = entries.len() > limit;
        entries.truncate(limit);
        let next_cursor = has_more
            .then(|| entries.last().map(|(_, cursor)| cursor.clone()))
            .flatten();
        Ok(PublicationPage {
            papers: entries.into_iter().map(|(paper, _)| paper).collect(),
            next_cursor,
        })
    }

    async fn github_trending_view(
        &self,
        period: &str,
        language: &GitHubTrendingLanguageSelector,
        spoken_language: Option<&str>,
        snapshot_date: Option<&str>,
    ) -> Result<GitHubTrendingView, StoreError> {
        let snapshots = {
            let snapshots = self
                .github_trending
                .lock()
                .expect("fake Trending snapshot should lock");
            snapshots
                .iter()
                .filter(|snapshot| {
                    snapshot.period == period
                        && (matches!(language, GitHubTrendingLanguageSelector::All)
                            || snapshot.language.as_str() == language.as_str())
                        && snapshot.spoken_language.as_deref() == spoken_language
                        && snapshot_date.is_none_or(|date| snapshot.snapshot_date == date)
                })
                .cloned()
                .collect()
        };
        Ok(GitHubTrendingView {
            snapshots,
            previous_date: None,
            next_date: None,
            available_languages: vec!["rust".to_owned(), "typescript".to_owned()],
        })
    }

    async fn ingest_github_trending_snapshot(
        &self,
        snapshot: NewGitHubTrendingSnapshot,
        actor: &str,
        idempotency_key: &str,
    ) -> Result<TrendingImportOutcome, StoreError> {
        self.trending_actors
            .lock()
            .expect("fake Trending actors should lock")
            .push(actor.to_owned());
        if snapshot
            .entries
            .iter()
            .flat_map(|entry| [entry.stars, entry.forks, entry.stars_in_period])
            .flatten()
            .any(|value| value < 0)
        {
            return Err(StoreError::InvalidTrendingSnapshot(
                "repository counts must not be negative",
            ));
        }
        let serialized = serde_json::to_string(&snapshot).expect("fake snapshot should serialize");
        let mut requests = self
            .trending_requests
            .lock()
            .expect("fake Trending requests should lock");
        if let Some(previous) = requests.get(idempotency_key) {
            if previous != &serialized {
                return Err(StoreError::IdempotencyConflict);
            }
            return Ok(TrendingImportOutcome {
                snapshot_id: 42,
                entry_count: snapshot.entries.len(),
                inserted: false,
            });
        }
        requests.insert(idempotency_key.to_owned(), serialized);
        Ok(TrendingImportOutcome {
            snapshot_id: 42,
            entry_count: snapshot.entries.len(),
            inserted: true,
        })
    }
}

fn repository_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("API crate must be inside the workspace crates directory")
}

fn submission_markdown() -> String {
    let source = fs::read_to_string(repository_root().join("examples/papers/prodxiv.md"))
        .expect("exemplary paper should be readable");
    let mut paper = PaperDocument::from_markdown(&source).expect("exemplary paper should parse");
    paper.metadata.paper_id = None;
    paper.metadata.published_at = None;
    paper.metadata.revision = None;
    let metadata =
        serde_yaml::to_string(&paper.metadata).expect("submission metadata should serialize");
    format!("---\n{metadata}---\n{}", paper.markdown)
}

fn legacy_submission_markdown() -> String {
    let mut paper = PaperDocument::from_markdown(&submission_markdown())
        .expect("submission paper should parse");
    paper.metadata.schema_version = "1".to_owned();
    paper.metadata.writers.clear();
    paper.metadata.communication_email = None;
    for author in &mut paper.metadata.authors {
        author.id = None;
        author.kind = None;
    }
    paper.metadata.status = PaperStatus::Legacy(ProductStatus::Concept);
    let metadata =
        serde_yaml::to_string(&paper.metadata).expect("legacy metadata should serialize");
    format!("---\n{metadata}---\n{}", paper.markdown)
}

fn app(store: Arc<FakeStore>) -> axum::Router {
    router(
        AppState::new(store, TOKEN, "api_test")
            .with_bot_principal(Some(BOT_TOKEN.to_owned()), "paperbot:daily".to_owned())
            .with_trending_ingestion(
                Some(INGEST_TOKEN.to_owned()),
                "github_actions:daily_trending".to_owned(),
            ),
    )
}

fn oidc_app(store: Arc<FakeStore>) -> axum::Router {
    router(
        AppState::new(store, TOKEN, "api_test")
            .with_bot_principal(None, "paperbot:daily".to_owned())
            .with_trending_ingestion(None, "github_actions:daily_trending".to_owned())
            .with_github_oidc(Some(Arc::new(FakeGitHubOidcAuthenticator))),
    )
}

async fn json_body(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body should be readable");
    serde_json::from_slice(&bytes).expect("response should contain JSON")
}

#[tokio::test]
async fn reads_the_latest_github_trending_snapshot() {
    let store = Arc::new(FakeStore {
        github_trending: Mutex::new(vec![GitHubTrendingSnapshot {
            snapshot_date: "2026-07-29".to_owned(),
            captured_at: None,
            period: "daily".to_owned(),
            language: GitHubTrendingLanguageScope::Any,
            spoken_language: None,
            source_kind: "third_party_archive".to_owned(),
            source_url: "https://example.com/archive".to_owned(),
            source_revision: "abc123".to_owned(),
            entries: vec![GitHubTrendingEntry {
                rank: 1,
                repository_full_name: "pascalorg/editor".to_owned(),
                repository_node_id: None,
                description: Some("A repository".to_owned()),
                primary_language: Some("TypeScript".to_owned()),
                stars: None,
                forks: None,
                stars_in_period: None,
            }],
        }]),
        ..FakeStore::default()
    });
    let response = app(store)
        .oneshot(
            Request::get("/v1/github/trending?period=daily")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["requested_language"], "any");
    assert_eq!(body["snapshots"][0]["snapshot_date"], "2026-07-29");
    assert_eq!(body["snapshots"][0]["language"], "any");
    assert_eq!(body["available_languages"][0], "rust");
    assert!(body["previous_date"].is_null());
    assert_eq!(
        body["snapshots"][0]["entries"][0]["repository_url"],
        "https://github.com/pascalorg/editor"
    );
}

#[tokio::test]
async fn reads_all_github_trending_language_scopes() {
    let snapshot = |language| GitHubTrendingSnapshot {
        snapshot_date: "2026-07-29".to_owned(),
        captured_at: None,
        period: "daily".to_owned(),
        language,
        spoken_language: None,
        source_kind: "third_party_archive".to_owned(),
        source_url: "https://example.com/archive".to_owned(),
        source_revision: "abc123".to_owned(),
        entries: Vec::new(),
    };
    let store = Arc::new(FakeStore {
        github_trending: Mutex::new(vec![
            snapshot(GitHubTrendingLanguageScope::Any),
            snapshot(GitHubTrendingLanguageScope::Language("rust".to_owned())),
        ]),
        ..FakeStore::default()
    });
    let response = app(store)
        .oneshot(
            Request::get("/v1/github/trending?period=daily&language=all")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["requested_language"], "all");
    assert_eq!(body["snapshots"].as_array().map(Vec::len), Some(2));
    assert_eq!(body["snapshots"][0]["language"], "any");
    assert_eq!(body["snapshots"][1]["language"], "rust");
}

#[tokio::test]
async fn ingests_a_trending_snapshot_idempotently() {
    let store = Arc::new(FakeStore::default());
    let application = app(store.clone());
    let request = || {
        Request::post("/v1/github/trending/snapshots")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {INGEST_TOKEN}"))
            .header("idempotency-key", "github-trending.test.rust")
            .header("x-prodxiv-actor", "github_actions:daily_trending")
            .body(Body::from(trending_snapshot_json().to_string()))
            .expect("request should build")
    };

    let first = application
        .clone()
        .oneshot(request())
        .await
        .expect("first ingestion should complete");
    let replay = application
        .oneshot(request())
        .await
        .expect("replayed ingestion should complete");

    assert_eq!(first.status(), StatusCode::CREATED);
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(json_body(first).await["inserted"], true);
    assert_eq!(json_body(replay).await["inserted"], false);
    assert_eq!(
        store
            .trending_requests
            .lock()
            .expect("fake Trending requests should lock")
            .len(),
        1
    );
    assert_eq!(
        store
            .trending_actors
            .lock()
            .expect("fake Trending actors should lock")
            .as_slice(),
        [
            "github_actions:daily_trending",
            "github_actions:daily_trending"
        ]
    );
}

#[tokio::test]
async fn rejects_all_as_an_ingested_language_scope() {
    let mut snapshot = trending_snapshot_json();
    snapshot["language"] = json!("all");
    let response = app(Arc::new(FakeStore::default()))
        .oneshot(
            Request::post("/v1/github/trending/snapshots")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {INGEST_TOKEN}"))
                .header("idempotency-key", "github-trending.test.all")
                .header("x-prodxiv-actor", "github_actions:daily_trending")
                .body(Body::from(snapshot.to_string()))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = json_body(response).await;
    assert_eq!(body["error"]["code"], "trending.snapshot_invalid");
    assert!(
        body["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("all is query-only"))
    );
}

#[tokio::test]
async fn protects_trending_ingestion_with_a_dedicated_token() {
    let response = app(Arc::new(FakeStore::default()))
        .oneshot(
            Request::post("/v1/github/trending/snapshots")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header("idempotency-key", "github-trending.test.unauthorized")
                .header("x-prodxiv-actor", "github_actions:daily_trending")
                .body(Body::from(trending_snapshot_json().to_string()))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn maps_the_paperbot_oidc_workflow_to_bot_owned_drafts_only() {
    let application = oidc_app(Arc::new(FakeStore::default()));
    let created = application
        .clone()
        .oneshot(
            Request::post("/v1/drafts")
                .header(header::CONTENT_TYPE, "application/json")
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {PAPERBOT_OIDC_TOKEN}"),
                )
                .header("idempotency-key", "draft-create-oidc-paperbot")
                .body(Body::from(
                    json!({ "source_markdown": "# Draft" }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("OIDC draft creation should complete");
    assert_eq!(created.status(), StatusCode::CREATED);
    assert_eq!(json_body(created).await["owner_kind"], "bot");

    let rejected = application
        .oneshot(
            Request::post("/v1/drafts")
                .header(header::CONTENT_TYPE, "application/json")
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {TRENDING_OIDC_TOKEN}"),
                )
                .header("idempotency-key", "draft-create-oidc-trending")
                .body(Body::from(
                    json!({ "source_markdown": "# Draft" }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("cross-workload request should complete");
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn maps_the_trending_oidc_workflow_to_its_server_owned_actor() {
    let store = Arc::new(FakeStore::default());
    let application = oidc_app(store.clone());
    let rejected = application
        .clone()
        .oneshot(
            Request::post("/v1/github/trending/snapshots")
                .header(header::CONTENT_TYPE, "application/json")
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {PAPERBOT_OIDC_TOKEN}"),
                )
                .header("idempotency-key", "github-trending.oidc.cross-role")
                .body(Body::from(trending_snapshot_json().to_string()))
                .expect("request should build"),
        )
        .await
        .expect("cross-workload request should complete");
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);

    let ingested = application
        .oneshot(
            Request::post("/v1/github/trending/snapshots")
                .header(header::CONTENT_TYPE, "application/json")
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {TRENDING_OIDC_TOKEN}"),
                )
                .header("idempotency-key", "github-trending.oidc.accepted")
                .header("x-prodxiv-actor", "spoofed:actor")
                .body(Body::from(trending_snapshot_json().to_string()))
                .expect("request should build"),
        )
        .await
        .expect("OIDC ingestion should complete");
    assert_eq!(ingested.status(), StatusCode::CREATED);
    assert_eq!(
        store
            .trending_actors
            .lock()
            .expect("fake Trending actors should lock")
            .as_slice(),
        ["github_actions:daily_trending"]
    );
}

#[tokio::test]
async fn requires_a_trending_ingestion_actor() {
    let response = app(Arc::new(FakeStore::default()))
        .oneshot(
            Request::post("/v1/github/trending/snapshots")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {INGEST_TOKEN}"))
                .header("idempotency-key", "github-trending.test.actor")
                .body(Body::from(trending_snapshot_json().to_string()))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        json_body(response).await["error"]["code"],
        "request.invalid_ingestion_actor"
    );
}

#[tokio::test]
async fn keeps_reading_available_when_trending_ingestion_is_not_configured() {
    let application = router(AppState::new(
        Arc::new(FakeStore::default()),
        TOKEN,
        "api_test",
    ));
    let ingestion = application
        .clone()
        .oneshot(
            Request::post("/v1/github/trending/snapshots")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {INGEST_TOKEN}"))
                .header("idempotency-key", "github-trending.test.unconfigured")
                .header("x-prodxiv-actor", "github_actions:daily_trending")
                .body(Body::from(trending_snapshot_json().to_string()))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(ingestion.status(), StatusCode::SERVICE_UNAVAILABLE);

    let reading = application
        .oneshot(
            Request::get("/v1/github/trending?period=daily")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("read request should complete");
    assert_eq!(reading.status(), StatusCode::OK);
}

#[tokio::test]
async fn rejects_invalid_trending_snapshots_and_idempotency_conflicts() {
    let application = app(Arc::new(FakeStore::default()));
    let request = |body: Value| {
        Request::post("/v1/github/trending/snapshots")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {INGEST_TOKEN}"))
            .header("idempotency-key", "github-trending.test.conflict")
            .header("x-prodxiv-actor", "github_actions:daily_trending")
            .body(Body::from(body.to_string()))
            .expect("request should build")
    };

    let first = application
        .clone()
        .oneshot(request(trending_snapshot_json()))
        .await
        .expect("first request should complete");
    assert_eq!(first.status(), StatusCode::CREATED);

    let mut conflict = trending_snapshot_json();
    conflict["source_revision"] = json!("sha256:different");
    let conflict = application
        .clone()
        .oneshot(request(conflict))
        .await
        .expect("conflicting request should complete");
    assert_eq!(conflict.status(), StatusCode::CONFLICT);

    let mut invalid = trending_snapshot_json();
    invalid["entries"][0]["stars"] = json!(-1);
    let invalid = application
        .oneshot(
            Request::post("/v1/github/trending/snapshots")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {INGEST_TOKEN}"))
                .header("idempotency-key", "github-trending.test.invalid")
                .header("x-prodxiv-actor", "github_actions:daily_trending")
                .body(Body::from(invalid.to_string()))
                .expect("request should build"),
        )
        .await
        .expect("invalid request should complete");
    assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);
}

fn trending_snapshot_json() -> Value {
    json!({
      "snapshot_date": "2026-07-31",
      "captured_at": "2026-07-31T02:17:00Z",
      "period": "daily",
      "language": "rust",
      "spoken_language": null,
      "source_kind": "direct_fetch",
      "source_url": "https://github.com/trending/rust?since=daily",
      "source_revision": "sha256:example",
      "entries": [{
        "repository_full_name": "acme/rust",
        "repository_node_id": null,
        "description": "A useful tool",
        "primary_language": "Rust",
        "stars": 100,
        "forks": 10,
        "stars_in_period": 5
      }]
    })
}

#[tokio::test]
async fn publishing_requires_authorization() {
    let store = Arc::new(FakeStore::default());
    let response = app(store.clone())
        .oneshot(
            Request::post("/v1/papers")
                .header(header::CONTENT_TYPE, "application/json")
                .header("idempotency-key", "paperbot.test.unauthorized")
                .body(Body::from(
                    json!({ "source_markdown": submission_markdown() }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(
        store
            .publications
            .lock()
            .expect("fake store should lock")
            .is_empty()
    );
}

#[tokio::test]
async fn creates_a_draft_idempotently() {
    let application = app(Arc::new(FakeStore::default()));
    let request = |source_markdown: &str| {
        Request::post("/v1/drafts")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .header("idempotency-key", "draft-create-http-replay")
            .body(Body::from(
                json!({ "source_markdown": source_markdown }).to_string(),
            ))
            .expect("request should build")
    };

    let first = application
        .clone()
        .oneshot(request("# Working notes\n"))
        .await
        .expect("draft creation should complete");
    let first_location = first.headers()[header::LOCATION].clone();
    assert_eq!(first.status(), StatusCode::CREATED);

    let replay = application
        .clone()
        .oneshot(request("# Working notes\n"))
        .await
        .expect("draft replay should complete");
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(replay.headers()[header::LOCATION], first_location);

    let conflict = application
        .oneshot(request("# Different notes\n"))
        .await
        .expect("conflicting draft creation should complete");
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    assert_eq!(
        json_body(conflict).await["error"]["code"],
        "draft.idempotency_conflict"
    );
}

#[tokio::test]
async fn creates_updates_lists_and_deletes_a_uuid_scoped_draft() {
    let application = app(Arc::new(FakeStore::default()));
    let created = application
        .clone()
        .oneshot(
            Request::post("/v1/drafts")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header("idempotency-key", "draft-create-http-crud")
                .body(Body::from(
                    json!({ "source_markdown": "# Working notes\n" }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("draft creation should complete");
    assert_eq!(created.status(), StatusCode::CREATED);
    assert_eq!(created.headers()[header::ETAG], "\"1\"");
    let location = created.headers()[header::LOCATION]
        .to_str()
        .expect("location should be text")
        .to_owned();
    let paper_uuid = location
        .strip_prefix("/v1/drafts/")
        .expect("location should identify a draft")
        .to_owned();
    let created_body = json_body(created).await;
    assert_eq!(created_body["paper_uuid"], paper_uuid);
    assert_eq!(created_body["revision"], 1);
    assert_eq!(created_body["review"]["status"], "pending_review");

    for expected_revision in 1..=6 {
        let response = application
            .clone()
            .oneshot(
                Request::put(&location)
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .header(header::IF_MATCH, format!("\"{expected_revision}\""))
                    .body(Body::from(
                        json!({
                          "source_markdown": format!("# Working notes {expected_revision}\n")
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("draft update should complete");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::ETAG],
            format!("\"{}\"", expected_revision + 1)
        );
    }

    let revisions = application
        .clone()
        .oneshot(
            Request::get(format!("{location}/revisions"))
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("draft revision list should complete");
    assert_eq!(revisions.status(), StatusCode::OK);
    let revisions = json_body(revisions).await;
    assert_eq!(revisions["retained_revision_limit"], 5);
    assert_eq!(revisions["revisions"].as_array().map(Vec::len), Some(5));
    assert_eq!(revisions["revisions"][0]["revision"], 7);
    assert_eq!(revisions["revisions"][4]["revision"], 3);

    let pruned = application
        .clone()
        .oneshot(
            Request::get(format!("{location}/revisions/1"))
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("pruned revision lookup should complete");
    assert_eq!(pruned.status(), StatusCode::NOT_FOUND);

    let listed = application
        .clone()
        .oneshot(
            Request::get("/v1/drafts")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("draft list should complete");
    let listed = json_body(listed).await;
    assert_eq!(listed["drafts"][0]["paper_uuid"], paper_uuid);
    assert_eq!(listed["drafts"][0]["revision"], 7);

    let deleted = application
        .clone()
        .oneshot(
            Request::delete(&location)
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"7\"")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("draft deletion should complete");
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);

    let missing = application
        .oneshot(
            Request::get(&location)
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("deleted draft lookup should complete");
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn reviews_exact_draft_revisions_without_deleting_rejections() {
    let application = app(Arc::new(FakeStore::default()));
    let created = application
        .clone()
        .oneshot(
            Request::post("/v1/drafts")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header("idempotency-key", "draft-create-http-review")
                .body(Body::from(
                    json!({ "source_markdown": submission_markdown() }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("draft creation should complete");
    let location = created.headers()[header::LOCATION]
        .to_str()
        .expect("location should be text")
        .to_owned();

    let rejected = application
        .clone()
        .oneshot(
            Request::post(format!("{location}/reject"))
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"1\"")
                .body(Body::from(
                    json!({ "reason": "The author wants revisions" }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("draft rejection should complete");
    assert_eq!(rejected.status(), StatusCode::OK);
    let rejected = json_body(rejected).await;
    assert_eq!(rejected["review"]["status"], "rejected");
    assert_eq!(rejected["review"]["reviewed_revision"], 1);
    assert_eq!(
        rejected["review"]["rejection_reason"],
        "The author wants revisions"
    );

    let listed = application
        .clone()
        .oneshot(
            Request::get("/v1/drafts?review_status=rejected")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("rejected draft list should complete");
    assert_eq!(
        json_body(listed).await["drafts"].as_array().map(Vec::len),
        Some(1)
    );

    let edited = application
        .clone()
        .oneshot(
            Request::put(&location)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"1\"")
                .body(Body::from(
                    json!({ "source_markdown": submission_markdown() }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("rejected draft edit should complete");
    let edited = json_body(edited).await;
    assert_eq!(edited["revision"], 2);
    assert_eq!(edited["review"]["status"], "pending_review");
    assert!(edited["review"].get("reviewed_revision").is_none());

    let approved = application
        .clone()
        .oneshot(
            Request::post(format!("{location}/approve"))
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"2\"")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("draft approval should complete");
    let approved = json_body(approved).await;
    assert_eq!(approved["review"]["status"], "approved");
    assert_eq!(approved["review"]["reviewed_revision"], 2);

    let stale_rejection = application
        .oneshot(
            Request::post(format!("{location}/reject"))
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"1\"")
                .body(Body::from(json!({}).to_string()))
                .expect("request should build"),
        )
        .await
        .expect("stale rejection should complete");
    assert_eq!(stale_rejection.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn confines_bot_auto_publication_to_unchanged_bot_owned_drafts() {
    let application = app(Arc::new(FakeStore::default()));
    let created = application
        .clone()
        .oneshot(
            Request::post("/v1/drafts")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {BOT_TOKEN}"))
                .header("idempotency-key", "draft-create-http-bot-owned")
                .body(Body::from(
                    json!({ "source_markdown": submission_markdown() }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("bot draft creation should complete");
    assert_eq!(created.status(), StatusCode::CREATED);
    let created_body = json_body(created).await;
    assert_eq!(created_body["owner_kind"], "bot");
    let paper_uuid = created_body["paper_uuid"]
        .as_str()
        .expect("draft UUID should be text");
    let draft_location = format!("/v1/drafts/{paper_uuid}");

    let edited = application
        .clone()
        .oneshot(
            Request::put(&draft_location)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"1\"")
                .body(Body::from(
                    json!({ "source_markdown": submission_markdown() }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("author draft edit should complete");
    assert_eq!(edited.status(), StatusCode::OK);
    let edited_body = json_body(edited).await;
    assert_eq!(edited_body["owner_kind"], "author");

    let forbidden_edit = application
        .clone()
        .oneshot(
            Request::put(&draft_location)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {BOT_TOKEN}"))
                .header(header::IF_MATCH, "\"2\"")
                .body(Body::from(
                    json!({ "source_markdown": submission_markdown() }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("bot edit attempt should complete");
    assert_eq!(forbidden_edit.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        json_body(forbidden_edit).await["error"]["code"],
        "draft.owner_forbidden"
    );

    let forbidden = application
        .clone()
        .oneshot(
            Request::post(format!("{draft_location}/approve-and-publish"))
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {BOT_TOKEN}"))
                .header(header::IF_MATCH, "\"2\"")
                .header("idempotency-key", "draft-bot-auto-publish-transferred")
                .body(Body::from(json!({}).to_string()))
                .expect("request should build"),
        )
        .await
        .expect("bot publication attempt should complete");
    assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        json_body(forbidden).await["error"]["code"],
        "draft.owner_forbidden"
    );

    let bot_owned = application
        .clone()
        .oneshot(
            Request::post("/v1/drafts")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {BOT_TOKEN}"))
                .header("idempotency-key", "draft-create-http-bot-auto")
                .body(Body::from(
                    json!({ "source_markdown": submission_markdown() }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("second bot draft creation should complete");
    let bot_owned_body = json_body(bot_owned).await;
    let bot_owned_uuid = bot_owned_body["paper_uuid"]
        .as_str()
        .expect("draft UUID should be text");
    let published = application
        .oneshot(
            Request::post(format!("/v1/drafts/{bot_owned_uuid}/approve-and-publish"))
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {BOT_TOKEN}"))
                .header(header::IF_MATCH, "\"1\"")
                .header("idempotency-key", "draft-bot-auto-publish-owned")
                .body(Body::from(json!({}).to_string()))
                .expect("request should build"),
        )
        .await
        .expect("bot-owned draft publication should complete");
    assert_eq!(published.status(), StatusCode::CREATED);
    assert_eq!(
        json_body(published).await["paper_id"],
        "prodxiv:2607.000001"
    );
}

#[tokio::test]
async fn publishes_an_exact_draft_revision_and_replays_after_deletion() {
    let application = app(Arc::new(FakeStore::default()));
    let created = application
        .clone()
        .oneshot(
            Request::post("/v1/drafts")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header("idempotency-key", "draft-create-http-publish")
                .body(Body::from(
                    json!({ "source_markdown": submission_markdown() }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("draft creation should complete");
    let draft_location = created.headers()[header::LOCATION]
        .to_str()
        .expect("location should be text")
        .to_owned();
    let publish_location = format!("{draft_location}/publish");

    let approved = application
        .clone()
        .oneshot(
            Request::post(format!("{draft_location}/approve"))
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"1\"")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("draft approval should complete");
    assert_eq!(approved.status(), StatusCode::OK);
    assert_eq!(json_body(approved).await["review"]["status"], "approved");

    let published = application
        .clone()
        .oneshot(
            Request::post(&publish_location)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"1\"")
                .header("idempotency-key", "draft-publish-http-1")
                .body(Body::from(json!({}).to_string()))
                .expect("request should build"),
        )
        .await
        .expect("draft publication should complete");
    assert_eq!(published.status(), StatusCode::CREATED);
    assert_eq!(
        published.headers()[header::LOCATION],
        "/v1/papers/prodxiv:2607.000001/revisions/1"
    );
    let published_body = json_body(published).await;
    assert_eq!(published_body["paper_id"], "prodxiv:2607.000001");
    assert_eq!(published_body["version"], 1);

    let deleted_draft = application
        .clone()
        .oneshot(
            Request::get(&draft_location)
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("published draft lookup should complete");
    assert_eq!(deleted_draft.status(), StatusCode::NOT_FOUND);

    let replayed = application
        .clone()
        .oneshot(
            Request::post(&publish_location)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"1\"")
                .header("idempotency-key", "draft-publish-http-1")
                .body(Body::from(json!({}).to_string()))
                .expect("request should build"),
        )
        .await
        .expect("draft publication replay should complete");
    assert_eq!(replayed.status(), StatusCode::OK);
    assert_eq!(json_body(replayed).await, published_body);

    let conflicting_replay = application
        .clone()
        .oneshot(
            Request::post(&publish_location)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"2\"")
                .header("idempotency-key", "draft-publish-http-1")
                .body(Body::from(json!({}).to_string()))
                .expect("request should build"),
        )
        .await
        .expect("conflicting draft publication replay should complete");
    assert_eq!(conflicting_replay.status(), StatusCode::CONFLICT);
    assert_eq!(
        json_body(conflicting_replay).await["error"]["code"],
        "publication.idempotency_conflict"
    );

    let missing_with_new_key = application
        .oneshot(
            Request::post(&publish_location)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"1\"")
                .header("idempotency-key", "draft-publish-http-2")
                .body(Body::from(json!({}).to_string()))
                .expect("request should build"),
        )
        .await
        .expect("missing draft publication should complete");
    assert_eq!(missing_with_new_key.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn keeps_an_unpublishable_draft_available_for_revision() {
    let application = app(Arc::new(FakeStore::default()));
    let created = application
        .clone()
        .oneshot(
            Request::post("/v1/drafts")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header("idempotency-key", "draft-create-http-invalid")
                .body(Body::from(
                    json!({ "source_markdown": "# Incomplete working notes\n" }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("draft creation should complete");
    let draft_location = created.headers()[header::LOCATION]
        .to_str()
        .expect("location should be text")
        .to_owned();
    let failed = application
        .clone()
        .oneshot(
            Request::post(format!("{draft_location}/approve"))
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"1\"")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("invalid draft approval should complete");
    assert_eq!(failed.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        json_body(failed).await["error"]["code"],
        "paper.invalid_markdown"
    );

    let not_approved = application
        .clone()
        .oneshot(
            Request::post(format!("{draft_location}/publish"))
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"1\"")
                .header("idempotency-key", "draft-publish-invalid")
                .body(Body::from(json!({}).to_string()))
                .expect("request should build"),
        )
        .await
        .expect("unapproved draft publication should complete");
    assert_eq!(not_approved.status(), StatusCode::CONFLICT);
    assert_eq!(
        json_body(not_approved).await["error"]["code"],
        "draft.not_approved"
    );

    let retained = application
        .oneshot(
            Request::get(&draft_location)
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("failed draft publication lookup should complete");
    assert_eq!(retained.status(), StatusCode::OK);
}

#[tokio::test]
async fn accepts_two_mib_draft_sources_after_json_escaping() {
    const TWO_MIB: usize = 2 * 1024 * 1024;

    let application = app(Arc::new(FakeStore::default()));
    let source = format!("#{}", "\\".repeat(TWO_MIB - 1));
    assert_eq!(source.len(), TWO_MIB);
    let created = application
        .clone()
        .oneshot(
            Request::post("/v1/drafts")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header("idempotency-key", "draft-create-http-max-source")
                .body(Body::from(json!({ "source_markdown": source }).to_string()))
                .expect("request should build"),
        )
        .await
        .expect("maximum-size draft creation should complete");
    assert_eq!(created.status(), StatusCode::CREATED);
    let location = created.headers()[header::LOCATION]
        .to_str()
        .expect("location should be text")
        .to_owned();

    let revised_source = format!("!{}", "\\".repeat(TWO_MIB - 1));
    let updated = application
        .clone()
        .oneshot(
            Request::put(&location)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"1\"")
                .body(Body::from(
                    json!({ "source_markdown": revised_source }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("maximum-size draft update should complete");
    assert_eq!(updated.status(), StatusCode::OK);

    let oversized_source = format!("#{}", "x".repeat(TWO_MIB));
    let oversized = application
        .oneshot(
            Request::put(&location)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"2\"")
                .body(Body::from(
                    json!({ "source_markdown": oversized_source }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("oversized draft update should complete");
    assert_eq!(oversized.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        json_body(oversized).await["error"]["code"],
        "draft.source_too_large"
    );
}

#[tokio::test]
async fn protects_drafts_and_rejects_latest_or_stale_writes() {
    let application = app(Arc::new(FakeStore::default()));
    let unauthorized = application
        .clone()
        .oneshot(
            Request::get("/v1/drafts")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("unauthorized request should complete");
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let latest = application
        .clone()
        .oneshot(
            Request::get("/v1/drafts/latest")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("removed latest alias should complete");
    assert_eq!(latest.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        json_body(latest).await["error"]["code"],
        "draft.invalid_uuid"
    );

    let created = application
        .clone()
        .oneshot(
            Request::post("/v1/drafts")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header("idempotency-key", "draft-create-http-protection")
                .body(Body::from(
                    json!({ "source_markdown": "first" }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("draft creation should complete");
    let location = created.headers()[header::LOCATION]
        .to_str()
        .expect("location should be text")
        .to_owned();
    let first_update = application
        .clone()
        .oneshot(
            Request::put(&location)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"1\"")
                .body(Body::from(
                    json!({ "source_markdown": "second" }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("draft update should complete");
    assert_eq!(first_update.status(), StatusCode::OK);

    let stale = application
        .oneshot(
            Request::put(&location)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header(header::IF_MATCH, "\"1\"")
                .body(Body::from(
                    json!({ "source_markdown": "conflicting edit" }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("stale update should complete");
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    assert_eq!(
        json_body(stale).await["error"]["code"],
        "draft.revision_conflict"
    );
}

#[tokio::test]
async fn publishes_and_reads_one_exact_revision() {
    let store = Arc::new(FakeStore::default());
    let application = app(store);
    let response = application
        .clone()
        .oneshot(
            Request::post("/v1/papers")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header("idempotency-key", "paperbot.test.publish")
                .body(Body::from(
                    json!({
                      "source_markdown": submission_markdown(),
                      "product_id": "prodxiv-product:2607.00000A"
                    })
                    .to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(
        response.headers().get(header::LOCATION),
        Some(
            &"/v1/papers/prodxiv:2607.000001/revisions/1"
                .parse()
                .unwrap()
        )
    );
    let body = json_body(response).await;
    assert_eq!(body["paper_id"], "prodxiv:2607.000001");
    assert_eq!(body["product_id"], "prodxiv-product:2607.00000A");
    assert_eq!(body["version"], 1);

    let response = application
        .oneshot(
            Request::get("/v1/papers/prodxiv:2607.000001/revisions/1")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["paper_id"], "prodxiv:2607.000001");
}

#[tokio::test]
async fn lists_latest_papers_without_authorization() {
    let store = Arc::new(FakeStore::default());
    let application = app(store);
    let publish_response = application
        .clone()
        .oneshot(
            Request::post("/v1/papers")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header("idempotency-key", "paperbot.test.list")
                .body(Body::from(
                    json!({ "source_markdown": submission_markdown() }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(publish_response.status(), StatusCode::CREATED);

    let response = application
        .oneshot(
            Request::get("/v1/papers?limit=10")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("request should complete");
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["papers"][0]["paper_id"], "prodxiv:2607.000001");
    assert_eq!(body["papers"][0]["version"], 1);
    assert!(body["papers"][0].get("source_markdown").is_none());
    assert!(body.get("next_cursor").is_none());
}

#[tokio::test]
async fn rejects_invalid_list_pagination() {
    let application = app(Arc::new(FakeStore::default()));
    for path in ["/v1/papers?limit=0", "/v1/papers?cursor=not-a-cursor"] {
        let response = application
            .clone()
            .oneshot(
                Request::get(path)
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn rejects_server_owned_submission_metadata() {
    let source = fs::read_to_string(repository_root().join("examples/papers/prodxiv.md"))
        .expect("exemplary paper should be readable");
    let response = app(Arc::new(FakeStore::default()))
        .oneshot(
            Request::post("/v1/papers")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header("idempotency-key", "paperbot.test.invalid")
                .body(Body::from(json!({ "source_markdown": source }).to_string()))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = json_body(response).await;
    assert_eq!(body["error"]["code"], "paper.invalid");
    assert!(
        body["error"]["diagnostics"]
            .as_array()
            .expect("diagnostics should be an array")
            .iter()
            .any(|diagnostic| diagnostic["code"] == "submission.paper_id_forbidden")
    );
}

#[tokio::test]
async fn rejects_new_legacy_schema_submissions() {
    let response = app(Arc::new(FakeStore::default()))
        .oneshot(
            Request::post("/v1/papers")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .header("idempotency-key", "paperbot.test.legacy")
                .body(Body::from(
                    json!({ "source_markdown": legacy_submission_markdown() }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = json_body(response).await;
    assert!(
        body["error"]["diagnostics"]
            .as_array()
            .expect("diagnostics should be an array")
            .iter()
            .any(|diagnostic| diagnostic["code"] == "submission.current_schema_required")
    );
}

#[tokio::test]
async fn requires_an_idempotency_key() {
    let response = app(Arc::new(FakeStore::default()))
        .oneshot(
            Request::post("/v1/papers")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::from(
                    json!({ "source_markdown": submission_markdown() }).to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        json_body(response).await["error"]["code"],
        "request.idempotency_key_required"
    );
}

#[tokio::test]
async fn returns_the_original_publication_for_an_idempotent_retry() {
    let store = Arc::new(FakeStore::default());
    let application = app(store.clone());
    let request = || {
        Request::post("/v1/papers")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .header("idempotency-key", "paperbot.test.retry")
            .body(Body::from(
                json!({ "source_markdown": submission_markdown() }).to_string(),
            ))
            .expect("request should build")
    };

    let first = application
        .clone()
        .oneshot(request())
        .await
        .expect("first request should complete");
    let second = application
        .oneshot(request())
        .await
        .expect("retry should complete");

    assert_eq!(first.status(), StatusCode::CREATED);
    assert_eq!(second.status(), StatusCode::OK);
    assert_eq!(
        store
            .publications
            .lock()
            .expect("fake store should lock")
            .len(),
        1
    );
}

#[tokio::test]
async fn rejects_an_idempotency_key_reused_for_different_content() {
    let application = app(Arc::new(FakeStore::default()));
    let source = submission_markdown();
    let request = |source: String| {
        Request::post("/v1/papers")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .header("idempotency-key", "paperbot.test.conflict")
            .body(Body::from(json!({ "source_markdown": source }).to_string()))
            .expect("request should build")
    };

    let first = application
        .clone()
        .oneshot(request(source.clone()))
        .await
        .expect("first request should complete");
    let conflict = application
        .oneshot(request(format!("{source}\n")))
        .await
        .expect("conflicting request should complete");

    assert_eq!(first.status(), StatusCode::CREATED);
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    assert_eq!(
        json_body(conflict).await["error"]["code"],
        "publication.idempotency_conflict"
    );
}
