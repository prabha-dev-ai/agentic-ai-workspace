// The vector store API surface. Consumers import from this barrel only —
// the individual files are implementation layout.

export type { VectorDocument } from './VectorDocument.ts';
export type { SearchOptions } from './SearchOptions.ts';
export type { SearchResult } from './SearchResult.ts';

export type { VectorStore, VectorStoreDiagnostics } from './VectorStore.ts';
export { InMemoryVectorStore } from './InMemoryVectorStore.ts';

export {
  SimilarityMetric,
  cosineSimilarity,
  dotProduct,
  euclideanDistance,
  similarityScore,
} from './Similarity.ts';

export {
  VectorStoreError,
  VectorValidationError,
  DimensionMismatchError,
  DocumentNotFoundError,
  DuplicateDocumentError,
} from './VectorErrors.ts';

export { createVectorStorePlugin } from './VectorStorePlugin.ts';
