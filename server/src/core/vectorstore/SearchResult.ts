import type { SimilarityMetric } from './Similarity.ts';
import type { VectorDocument } from './VectorDocument.ts';

/** One search hit. Higher score = more similar, regardless of metric —
 *  see similarityScore() in Similarity.ts for how that is guaranteed. */
export interface SearchResult {
  document: VectorDocument;
  score: number;
  /** Which metric produced the score — scores from different metrics
   *  are not comparable, so provenance travels with the result. */
  metric: SimilarityMetric;
}
