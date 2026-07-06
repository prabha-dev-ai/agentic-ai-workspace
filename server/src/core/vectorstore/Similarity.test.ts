import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SimilarityMetric,
  cosineSimilarity,
  dotProduct,
  euclideanDistance,
  similarityScore,
} from './Similarity.ts';
import { DimensionMismatchError } from './VectorErrors.ts';

describe('cosine similarity', () => {
  test('same direction scores 1, regardless of magnitude', () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    // Scaled vectors accumulate floating-point error — compare with a
    // tolerance instead of demanding an exact 1.
    const scaled = cosineSimilarity([1, 2], [2, 4]);
    assert.ok(Math.abs(scaled - 1) < 1e-12, `expected ~1, got ${scaled}`);
  });

  test('orthogonal vectors score 0', () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });

  test('opposite vectors score -1', () => {
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  });

  test('a zero vector has no direction — similarity is defined as 0', () => {
    assert.equal(cosineSimilarity([0, 0], [3, 4]), 0);
  });
});

describe('dot product', () => {
  test('computes the sum of pairwise products', () => {
    assert.equal(dotProduct([1, 2, 3], [4, 5, 6]), 32);
  });

  test('is sensitive to magnitude, unlike cosine', () => {
    assert.ok(dotProduct([2, 4], [1, 2]) > dotProduct([1, 2], [1, 2]));
  });
});

describe('euclidean distance', () => {
  test('identical vectors have distance 0', () => {
    assert.equal(euclideanDistance([1, 2, 3], [1, 2, 3]), 0);
  });

  test('computes the classic 3-4-5 triangle', () => {
    assert.equal(euclideanDistance([0, 0], [3, 4]), 5);
  });
});

describe('dimension validation', () => {
  test('every measure rejects mismatched dimensions', () => {
    assert.throws(() => cosineSimilarity([1], [1, 2]), DimensionMismatchError);
    assert.throws(() => dotProduct([1], [1, 2]), DimensionMismatchError);
    assert.throws(() => euclideanDistance([1], [1, 2]), DimensionMismatchError);
  });
});

describe('similarityScore', () => {
  test('higher score always means more similar, for every metric', () => {
    const query = [1, 0];
    const near = [0.9, 0.1];
    const far = [-1, 5];

    for (const metric of Object.values(SimilarityMetric)) {
      const nearScore = similarityScore(metric, query, near);
      const farScore = similarityScore(metric, query, far);
      assert.ok(
        nearScore > farScore,
        `${metric}: near (${nearScore}) must beat far (${farScore})`,
      );
    }
  });

  test('euclidean is mapped into (0, 1] with 1 for identical vectors', () => {
    assert.equal(similarityScore(SimilarityMetric.Euclidean, [1, 2], [1, 2]), 1);

    const score = similarityScore(SimilarityMetric.Euclidean, [0, 0], [3, 4]);
    assert.equal(score, 1 / 6); // distance 5 -> 1 / (1 + 5)
  });
});
