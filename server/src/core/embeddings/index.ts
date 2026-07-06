// The embeddings API surface. Consumers import from this barrel only —
// the individual files are implementation layout.

export type { EmbeddingModel } from './EmbeddingModel.ts';
export { DEFAULT_EMBEDDING_MODEL } from './EmbeddingModel.ts';

export type { EmbeddingResult } from './EmbeddingResult.ts';

export type { EmbeddingProvider } from './EmbeddingProvider.ts';
export { OpenAIEmbeddingProvider } from './EmbeddingProvider.ts';

export { EmbeddingService } from './EmbeddingService.ts';
export type {
  EmbeddingServiceOptions,
  EmbeddingDiagnostics,
} from './EmbeddingService.ts';

export {
  EmbeddingError,
  EmbeddingValidationError,
  EmbeddingProviderError,
} from './EmbeddingErrors.ts';

export { createEmbeddingsPlugin } from './EmbeddingsPlugin.ts';
