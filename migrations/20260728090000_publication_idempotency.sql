CREATE TABLE publication_requests (
  actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  idempotency_key TEXT NOT NULL
    CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_sha256 TEXT NOT NULL
    CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  paper_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (actor, idempotency_key),
  FOREIGN KEY (paper_id, version)
    REFERENCES paper_versions (paper_id, version)
    ON DELETE RESTRICT
);

CREATE TRIGGER publication_requests_are_immutable
BEFORE UPDATE OR DELETE ON publication_requests
FOR EACH ROW
EXECUTE FUNCTION reject_immutable_row_change();
