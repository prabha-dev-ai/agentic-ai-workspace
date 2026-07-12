-- AAI-036: Persistent Storage Providers
-- Backs knowledge/postgres-knowledge-store.ts.

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL
);
