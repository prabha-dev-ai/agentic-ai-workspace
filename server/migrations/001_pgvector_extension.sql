-- AAI-036: Persistent Storage Providers
-- Enables pgvector, required by 002_vector_store.sql. Requires the
-- pgvector extension to be installed on the Postgres server/image
-- (e.g. the `pgvector/pgvector` Docker image, or `CREATE EXTENSION`
-- privileges on a managed Postgres that ships it, such as recent
-- Amazon RDS / Supabase / Neon).

CREATE EXTENSION IF NOT EXISTS vector;
