-- No INSERT ... SELECT: only publications created after this migration enroll.
CREATE TABLE paper_translation_jobs (
  paper_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en', 'zh-CN', 'ja', 'de', 'fr')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (paper_id, revision, language),
  FOREIGN KEY (paper_id, revision) REFERENCES paper_revisions (paper_id, revision)
);

CREATE TABLE paper_translations (
  paper_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  language TEXT NOT NULL,
  content JSONB NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (paper_id, revision, language),
  FOREIGN KEY (paper_id, revision, language)
    REFERENCES paper_translation_jobs (paper_id, revision, language)
);

CREATE TRIGGER paper_translations_are_immutable
BEFORE UPDATE OR DELETE ON paper_translations
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_change();

CREATE FUNCTION enqueue_paper_translations() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO paper_translation_jobs (paper_id, revision, language)
    SELECT NEW.paper_id, NEW.revision, language
    FROM unnest(ARRAY['en', 'zh-CN', 'ja', 'de', 'fr']) AS language;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enqueue_new_paper_translations
AFTER INSERT ON paper_revisions
FOR EACH ROW EXECUTE FUNCTION enqueue_paper_translations();
