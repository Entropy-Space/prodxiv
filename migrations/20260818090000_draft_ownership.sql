ALTER TABLE paper_drafts
ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'author',
ADD CONSTRAINT paper_drafts_owner_kind_is_known CHECK (
  owner_kind IN ('author', 'bot')
);

CREATE INDEX paper_drafts_automation_queue
ON paper_drafts (review_status, owner_kind, updated_at DESC, paper_uuid DESC);
