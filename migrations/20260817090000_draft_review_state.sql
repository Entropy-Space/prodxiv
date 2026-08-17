ALTER TABLE paper_drafts
ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending_review',
ADD COLUMN reviewed_revision INTEGER,
ADD COLUMN reviewed_by TEXT,
ADD COLUMN reviewed_at TIMESTAMPTZ,
ADD COLUMN rejection_reason TEXT,
ADD CONSTRAINT paper_drafts_review_status_is_known CHECK (
  review_status IN ('pending_review', 'approved', 'rejected')
),
ADD CONSTRAINT paper_drafts_review_is_revision_bound CHECK (
  (
    review_status = 'pending_review'
    AND reviewed_revision IS NULL
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND rejection_reason IS NULL
  )
  OR (
    review_status = 'approved'
    AND reviewed_revision = current_revision
    AND length(trim(reviewed_by)) > 0
    AND reviewed_at IS NOT NULL
    AND rejection_reason IS NULL
  )
  OR (
    review_status = 'rejected'
    AND reviewed_revision = current_revision
    AND length(trim(reviewed_by)) > 0
    AND reviewed_at IS NOT NULL
    AND (
      rejection_reason IS NULL
      OR octet_length(rejection_reason) <= 2000
    )
  )
);

CREATE INDEX paper_drafts_review_queue
ON paper_drafts (review_status, updated_at DESC, paper_uuid DESC);

CREATE TABLE paper_draft_creation_requests (
  actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  idempotency_key TEXT NOT NULL
    CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_sha256 TEXT NOT NULL
    CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  paper_uuid UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (actor, idempotency_key)
);

CREATE TRIGGER paper_draft_creation_requests_are_immutable
BEFORE UPDATE OR DELETE ON paper_draft_creation_requests
FOR EACH ROW
EXECUTE FUNCTION reject_immutable_row_change();
