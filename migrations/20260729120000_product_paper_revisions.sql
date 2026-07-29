ALTER TABLE paper_versions RENAME TO paper_revisions;
ALTER TABLE paper_revisions RENAME COLUMN version TO revision;
ALTER TRIGGER paper_versions_are_immutable ON paper_revisions
  RENAME TO paper_revisions_are_immutable;

ALTER TABLE audit_log RENAME COLUMN version TO revision;
ALTER TABLE publication_requests RENAME COLUMN version TO revision;

CREATE TABLE products (
  product_id TEXT PRIMARY KEY
    CHECK (
      product_id ~ '^prodxiv-product:[0-9]{4}\.[0-9A-HJKMNP-TV-Z]{6}$'
    ),
  initial_name TEXT NOT NULL CHECK (length(trim(initial_name)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE papers ADD COLUMN product_id TEXT;

UPDATE papers
SET product_id = replace(paper_id, 'prodxiv:', 'prodxiv-product:');

INSERT INTO products (product_id, initial_name, created_at)
SELECT
  papers.product_id,
  COALESCE(
    NULLIF(latest.metadata ->> 'product_name', ''),
    NULLIF(latest.metadata ->> 'title', ''),
    papers.paper_id
  ),
  papers.created_at
FROM papers
JOIN LATERAL (
  SELECT metadata
  FROM paper_revisions
  WHERE paper_revisions.paper_id = papers.paper_id
  ORDER BY revision DESC
  LIMIT 1
) AS latest ON TRUE;

ALTER TABLE papers ALTER COLUMN product_id SET NOT NULL;
ALTER TABLE papers
  ADD CONSTRAINT papers_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES products (product_id) ON DELETE RESTRICT;

CREATE TABLE product_resources (
  resource_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products (product_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('homepage', 'repository', 'documentation')),
  canonical_url TEXT NOT NULL CHECK (length(trim(canonical_url)) > 0),
  discovered_from_paper_id TEXT NOT NULL,
  discovered_from_revision INTEGER NOT NULL CHECK (discovered_from_revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (product_id, kind, canonical_url),
  FOREIGN KEY (discovered_from_paper_id, discovered_from_revision)
    REFERENCES paper_revisions (paper_id, revision)
    ON DELETE RESTRICT
);

CREATE TABLE github_repository_observations (
  observation_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resource_id BIGINT NOT NULL
    REFERENCES product_resources (resource_id)
    ON DELETE RESTRICT,
  repository_node_id TEXT NOT NULL CHECK (length(trim(repository_node_id)) > 0),
  repository_full_name TEXT NOT NULL
    CHECK (length(trim(repository_full_name)) > 0),
  stars BIGINT NOT NULL CHECK (stars >= 0),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (resource_id, observed_at)
);

INSERT INTO product_resources (
  product_id,
  kind,
  canonical_url,
  discovered_from_paper_id,
  discovered_from_revision,
  created_at
)
SELECT DISTINCT ON (papers.product_id, resources.kind, resources.canonical_url)
  papers.product_id,
  resources.kind,
  resources.canonical_url,
  paper_revisions.paper_id,
  paper_revisions.revision,
  paper_revisions.created_at
FROM paper_revisions
JOIN papers USING (paper_id)
CROSS JOIN LATERAL (
  VALUES
    ('homepage', paper_revisions.metadata ->> 'product_url'),
    ('repository', paper_revisions.metadata ->> 'repository_url')
) AS resources(kind, canonical_url)
WHERE resources.canonical_url IS NOT NULL
  AND length(trim(resources.canonical_url)) > 0
ORDER BY
  papers.product_id,
  resources.kind,
  resources.canonical_url,
  paper_revisions.revision;
