-- AAI-036: Persistent Storage Providers
-- Backs core/checkpoint/PostgresCheckpointStore.ts. Append-only: every
-- save() inserts a new row, nothing is ever updated in place — matches
-- InMemoryCheckpointStore's history semantics (list() is a full audit
-- trail, getLatest() is the newest row per subject_id).

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS checkpoints_subject_id_created_at_idx
  ON checkpoints (subject_id, created_at);
