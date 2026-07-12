import dotenv from 'dotenv';

dotenv.config();

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',

  port: Number(process.env.PORT) || 3000,

  llm: {
    provider: process.env.LLM_PROVIDER || 'openrouter',
    apiKey: process.env.LLM_API_KEY || '',
    baseUrl: process.env.LLM_BASE_URL || '',
    model: process.env.LLM_MODEL || '',
  },

  // Optional persistent-storage backends (AAI-036). Empty string means
  // "not configured" — bootstrap falls back to the in-memory defaults,
  // so no deployment is forced to run Postgres/Redis just to start.
  postgres: {
    url: process.env.DATABASE_URL || '',
    /** Column width for the pgvector-backed vector store. Must match the
     *  embedding model in use — see EmbeddingModel.ts. */
    vectorDimensions: Number(process.env.PG_VECTOR_DIMENSIONS) || 1536,
  },

  redis: {
    url: process.env.REDIS_URL || '',
  },
};