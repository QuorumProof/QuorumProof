-- Bootstrap changelog table. The runner also creates this defensively at
-- startup (see runner.ts ensureChangelogTable), so this migration is mostly
-- documentation of the tracked shape plus the one thing the runner doesn't
-- add itself: the checksum column used to detect a previously-applied
-- migration file being edited after the fact.
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    TEXT PRIMARY KEY,
  checksum    TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
