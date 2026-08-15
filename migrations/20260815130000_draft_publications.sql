CREATE TABLE paper_draft_publications (
  paper_uuid UUID PRIMARY KEY,
  draft_revision INTEGER NOT NULL CHECK (draft_revision > 0),
  paper_id TEXT NOT NULL,
  paper_revision INTEGER NOT NULL CHECK (paper_revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (paper_id),
  FOREIGN KEY (paper_id, paper_revision)
    REFERENCES paper_revisions (paper_id, revision)
    ON DELETE RESTRICT
);

CREATE TRIGGER paper_draft_publications_are_immutable
BEFORE UPDATE OR DELETE ON paper_draft_publications
FOR EACH ROW
EXECUTE FUNCTION reject_immutable_row_change();
