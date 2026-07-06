// Which embedding model a provider speaks for. Dimensions, when declared,
// are validated against every vector the provider returns — catching the
// classic bug of mixing vectors from different models in one store.
export interface EmbeddingModel {
  name: string;
  /** Expected vector dimensions; validated when provided. */
  dimensions?: number;
}

// The OpenAI-compatible default. NOTE: OpenRouter does not serve the
// /embeddings endpoint — using the default provider requires an
// OpenAI-compatible base URL that does.
export const DEFAULT_EMBEDDING_MODEL: EmbeddingModel = {
  name: 'text-embedding-3-small',
  dimensions: 1536,
};
