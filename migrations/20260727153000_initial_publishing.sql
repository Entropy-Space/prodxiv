CREATE TABLE paper_id_sequences (
  period TEXT PRIMARY KEY CHECK (period ~ '^[0-9]{4}$'),
  last_value BIGINT NOT NULL CHECK (last_value BETWEEN 1 AND 1073741823)
);

CREATE TABLE papers (
  paper_id TEXT PRIMARY KEY
    CHECK (paper_id ~ '^prodxiv:[0-9]{4}\.[0-9A-HJKMNP-TV-Z]{6}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE paper_versions (
  paper_id TEXT NOT NULL REFERENCES papers (paper_id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  published_at DATE NOT NULL,
  published_by TEXT NOT NULL CHECK (length(trim(published_by)) > 0),
  metadata JSONB NOT NULL,
  submitted_markdown TEXT NOT NULL CHECK (length(submitted_markdown) > 0),
  source_markdown TEXT NOT NULL CHECK (length(source_markdown) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (paper_id, version)
);

CREATE TABLE audit_log (
  audit_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  paper_id TEXT NOT NULL REFERENCES papers (paper_id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (paper_id, version)
    REFERENCES paper_versions (paper_id, version)
    ON DELETE RESTRICT
);

CREATE FUNCTION reject_immutable_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER paper_versions_are_immutable
BEFORE UPDATE OR DELETE ON paper_versions
FOR EACH ROW
EXECUTE FUNCTION reject_immutable_row_change();

CREATE TRIGGER audit_log_is_append_only
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW
EXECUTE FUNCTION reject_immutable_row_change();
