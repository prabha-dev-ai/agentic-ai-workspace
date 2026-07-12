# Migrations (AAI-036)

These scripts create the tables the persistent-storage providers use:
`PostgresVectorStore`, `PostgresCheckpointStore`, `PostgresKnowledgeStore`.

Each provider's own `connect()` method also runs the equivalent
`CREATE TABLE IF NOT EXISTS` / `CREATE EXTENSION IF NOT EXISTS` statement,
so the app boots and works correctly against a fresh database with no
migration step at all — that auto-DDL is what makes the framework's
zero-config default (no `DATABASE_URL` set) and first-run development
experience possible.

These files exist for deployments that manage schema explicitly instead
of relying on app-boot DDL (the norm once a database is shared across
more than one service, or once schema changes need review/rollback
outside of app code). Run them in order, with any migration tool that
executes plain SQL (`psql -f`, `node-pg-migrate`, `flyway`, etc.):

```
psql "$DATABASE_URL" -f migrations/001_pgvector_extension.sql
psql "$DATABASE_URL" -f migrations/002_vector_store.sql
psql "$DATABASE_URL" -f migrations/003_checkpoints.sql
psql "$DATABASE_URL" -f migrations/004_knowledge_store.sql
```

All four are idempotent (`IF NOT EXISTS` throughout) — safe to re-run.

`002_vector_store.sql`'s vector column width (1536) must match
`PG_VECTOR_DIMENSIONS` (see `server/src/config/env.ts`) and the embedding
model actually in use (`core/embeddings/EmbeddingModel.ts`). Mixing
dimensions between the column and the model produces a Postgres error at
insert time, not silent corruption.
