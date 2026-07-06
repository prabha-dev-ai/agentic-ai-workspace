import type { SimilarityMetric } from './Similarity.ts';

export interface SearchOptions {
  /** How many results to return. Default 5. */
  topK?: number;
  /** How to score candidates. Default cosine similarity. */
  metric?: SimilarityMetric;
  /** Metadata equality filter: every entry must match (AND semantics).
   *  Documents without metadata never match a non-empty filter. */
  filter?: Record<string, string | number | boolean>;
}
