-- AAI-036: Persistent Storage Providers
-- Backs core/vectorstore/PostgresVectorStore.ts. Column width (1536)
-- must match config/env.ts's PG_VECTOR_DIMENSIONS and the embedding
-- model in use (core/embeddings/EmbeddingModel.ts) — change both
-- together if the model changes.

CREATE TABLE IF NOT EXISTS vector_documents (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  vector vector(1536) NOT NULL,
  metadata JSONB
);

-- Approximate nearest-neighbor index for cosine distance — the default
-- metric (see core/vectorstore/Similarity.ts's SimilarityMetric.Cosine).
-- Without this, PostgresVectorStore.search() still works (pgvector falls
-- back to an exact sequential scan), just without the index speedup at
-- larger row counts. Build after loading a representative amount of data
-- for best `lists` tuning; 100 is a reasonable default for small/medium
-- corpora.
CREATE INDEX IF NOT EXISTS vector_documents_vector_cosine_idx
  ON vector_documents USING ivfflat (vector vector_cosine_ops) WITH (lists = 100);
