CREATE TABLE github_trending_snapshots (
  snapshot_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  captured_at TIMESTAMPTZ,
  period TEXT NOT NULL
    CHECK (period IN ('daily', 'weekly', 'monthly')),
  language TEXT,
  spoken_language TEXT,
  source_kind TEXT NOT NULL
    CHECK (
      source_kind IN (
        'direct_fetch',
        'third_party_archive',
        'wayback_reconstruction'
      )
    ),
  source_url TEXT NOT NULL CHECK (length(trim(source_url)) > 0),
  source_revision TEXT NOT NULL CHECK (length(trim(source_revision)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE NULLS NOT DISTINCT (
    snapshot_date,
    captured_at,
    period,
    language,
    spoken_language,
    source_kind,
    source_url,
    source_revision
  )
);

CREATE TABLE github_trending_entries (
  snapshot_id BIGINT NOT NULL
    REFERENCES github_trending_snapshots (snapshot_id)
    ON DELETE RESTRICT,
  rank INTEGER NOT NULL CHECK (rank > 0),
  repository_full_name TEXT NOT NULL
    CHECK (
      repository_full_name ~ '^[^/[:space:]]+/[^/[:space:]]+$'
    ),
  repository_node_id TEXT,
  description TEXT,
  primary_language TEXT,
  stars BIGINT CHECK (stars >= 0),
  forks BIGINT CHECK (forks >= 0),
  stars_in_period BIGINT CHECK (stars_in_period >= 0),
  PRIMARY KEY (snapshot_id, rank)
);

CREATE UNIQUE INDEX github_trending_entries_repository
  ON github_trending_entries (
    snapshot_id,
    lower(repository_full_name)
  );

CREATE INDEX github_trending_snapshots_latest
  ON github_trending_snapshots (
    period,
    language,
    spoken_language,
    snapshot_date DESC,
    captured_at DESC NULLS LAST
  );

CREATE TRIGGER github_trending_snapshots_are_immutable
BEFORE UPDATE OR DELETE ON github_trending_snapshots
FOR EACH ROW
EXECUTE FUNCTION reject_immutable_row_change();

CREATE TRIGGER github_trending_entries_are_immutable
BEFORE UPDATE OR DELETE ON github_trending_entries
FOR EACH ROW
EXECUTE FUNCTION reject_immutable_row_change();
