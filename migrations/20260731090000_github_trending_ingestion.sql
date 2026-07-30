ALTER TABLE github_trending_snapshots
ADD COLUMN ingested_by TEXT NOT NULL DEFAULT 'legacy_import'
  CHECK (length(trim(ingested_by)) > 0);

ALTER TABLE github_trending_snapshots
ALTER COLUMN ingested_by DROP DEFAULT;

CREATE TABLE github_trending_ingestion_requests (
  idempotency_key TEXT PRIMARY KEY
    CHECK (
      length(idempotency_key) BETWEEN 8 AND 128
      AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
    ),
  request_sha256 TEXT NOT NULL
    CHECK (request_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  snapshot_id BIGINT NOT NULL
    REFERENCES github_trending_snapshots (snapshot_id)
    ON DELETE RESTRICT,
  actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER github_trending_ingestion_requests_are_append_only
BEFORE UPDATE OR DELETE ON github_trending_ingestion_requests
FOR EACH ROW
EXECUTE FUNCTION reject_immutable_row_change();
