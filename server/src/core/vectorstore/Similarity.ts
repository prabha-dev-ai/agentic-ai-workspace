import { DimensionMismatchError } from './VectorErrors.ts';

// The three classic vector similarity measures, as pure functions.
//
// A const-object union instead of a TS enum: Node's type stripping
// cannot run enums (same pattern as PluginCapability).
export const SimilarityMetric = {
  Cosine: 'cosine',
  DotProduct: 'dot-product',
  Euclidean: 'euclidean',
} as const;

export type SimilarityMetric =
  (typeof SimilarityMetric)[keyof typeof SimilarityMetric];

function assertSameDimensions(a: number[], b: number[]): void {
  if (a.length !== b.length) {
    throw new DimensionMismatchError(a.length, b.length);
  }
}

export function dotProduct(a: number[], b: number[]): number {
  assertSameDimensions(a, b);

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

// Cosine measures the angle between vectors, ignoring their length:
// 1 = same direction, 0 = orthogonal, -1 = opposite. A zero vector has
// no direction, so its similarity to anything is defined here as 0
// rather than dividing by zero.
export function cosineSimilarity(a: number[], b: number[]): number {
  assertSameDimensions(a, b);

  const magnitudeA = Math.sqrt(dotProduct(a, a));
  const magnitudeB = Math.sqrt(dotProduct(b, b));

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct(a, b) / (magnitudeA * magnitudeB);
}

export function euclideanDistance(a: number[], b: number[]): number {
  assertSameDimensions(a, b);

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

// One scoring policy for search, whatever the metric: HIGHER score =
// MORE similar. Cosine and dot product already behave that way;
// euclidean is a distance (lower = closer), so it is mapped through
// 1 / (1 + d) into (0, 1] — identical vectors score 1, far vectors
// approach 0. Results from different metrics stay sortable the same way.
export function similarityScore(
  metric: SimilarityMetric,
  query: number[],
  target: number[],
): number {
  switch (metric) {
    case SimilarityMetric.Cosine:
      return cosineSimilarity(query, target);
    case SimilarityMetric.DotProduct:
      return dotProduct(query, target);
    case SimilarityMetric.Euclidean:
      return 1 / (1 + euclideanDistance(query, target));
  }
}
