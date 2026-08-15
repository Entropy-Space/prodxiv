CREATE TABLE paper_drafts (
  paper_uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE paper_draft_revisions (
  paper_uuid UUID NOT NULL
    REFERENCES paper_drafts (paper_uuid)
    ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  source_markdown TEXT NOT NULL CHECK (length(source_markdown) > 0),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (paper_uuid, revision)
);

CREATE INDEX paper_drafts_recently_updated
  ON paper_drafts (updated_at DESC, paper_uuid DESC);

CREATE TABLE paper_draft_audit_log (
  audit_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  paper_uuid UUID NOT NULL,
  revision INTEGER CHECK (revision > 0),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER paper_draft_revisions_cannot_be_updated
BEFORE UPDATE ON paper_draft_revisions
FOR EACH ROW
EXECUTE FUNCTION reject_immutable_row_change();

CREATE TRIGGER paper_draft_audit_log_is_append_only
BEFORE UPDATE OR DELETE ON paper_draft_audit_log
FOR EACH ROW
EXECUTE FUNCTION reject_immutable_row_change();
