import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RankingStrategyError,
  RankingValidationError,
  candidatesFromHybridResults,
  createKnowledgeRanker,
  createWeightedRankingStrategy,
} from './knowledge-ranker.ts';
import type { RankingCandidate, RankingStrategy } from './knowledge-ranker.ts';

function candidate(
  id: string,
  signals: Record<string, number>,
): RankingCandidate {
  return { id, text: `text of ${id}`, signals };
}

describe('weighted ranking strategy', () => {
  test('configured weights produce exact, verifiable scores', async () => {
    const strategy = createWeightedRankingStrategy({
      weights: { keyword: 3, vector: 1 },
    });

    const scored = await strategy.score('query', [
      candidate('a', { keyword: 1, vector: 0.5 }),
    ]);

    // (3 * 1 + 1 * 0.5) / 4
    assert.equal(scored[0]?.score, 0.875);
  });

  test('without configuration, every signal in the batch counts equally', async () => {
    const strategy = createWeightedRankingStrategy();

    const scored = await strategy.score('query', [
      candidate('a', { alpha: 1 }), // beta missing -> counts as 0
      candidate('b', { alpha: 0, beta: 1 }),
    ]);

    assert.equal(scored[0]?.score, 0.5); // (1 + 0) / 2
    assert.equal(scored[1]?.score, 0.5); // (0 + 1) / 2
  });

  test('every score is explained: contributions sum to the score', async () => {
    const strategy = createWeightedRankingStrategy({
      weights: { keyword: 2, vector: 1 },
    });

    const scored = await strategy.score('query', [
      candidate('a', { keyword: 0.8, vector: 0.4 }),
    ]);
    const explanation = scored[0]?.explanation;

    assert.equal(explanation?.strategy, 'weighted');

    const sum = explanation?.contributions.reduce(
      (total, entry) => total + entry.contribution,
      0,
    );
    assert.ok(Math.abs((sum ?? 0) - (scored[0]?.score ?? 0)) < 1e-12);

    // A missing signal is explained, not hidden.
    const signals = explanation?.contributions.map((entry) => entry.signal);
    assert.deepEqual(signals?.sort(), ['keyword', 'vector']);
    assert.ok(explanation?.summary.includes('keyword'));
    assert.ok(explanation?.summary.includes('weighted'));
  });

  test('invalid weight configurations are rejected at construction', () => {
    assert.throws(
      () => createWeightedRankingStrategy({ weights: {} }),
      RankingValidationError,
    );
    assert.throws(
      () => createWeightedRankingStrategy({ weights: { keyword: -1 } }),
      RankingValidationError,
    );
    assert.throws(
      () => createWeightedRankingStrategy({ weights: { keyword: 0, vector: 0 } }),
      RankingValidationError,
    );
  });

  test('non-finite signal values are rejected', async () => {
    const strategy = createWeightedRankingStrategy();

    await assert.rejects(
      async () => strategy.score('query', [candidate('a', { bad: Number.NaN })]),
      RankingValidationError,
    );
  });
});

describe('knowledge ranker service', () => {
  test('sorts by score, assigns 1-based ranks, breaks ties by id', async () => {
    const ranker = createKnowledgeRanker(createWeightedRankingStrategy());

    const results = await ranker.rank('query', [
      candidate('zeta', { s: 0.5 }),
      candidate('best', { s: 1 }),
      candidate('alpha', { s: 0.5 }),
    ]);

    assert.deepEqual(
      results.map((r) => [r.rank, r.candidate.id]),
      [
        [1, 'best'],
        [2, 'alpha'], // tie with zeta -> id order
        [3, 'zeta'],
      ],
    );
  });

  test('limit returns only the best N, still ranked from 1', async () => {
    const ranker = createKnowledgeRanker(createWeightedRankingStrategy());

    const results = await ranker.rank(
      'query',
      [candidate('a', { s: 0.1 }), candidate('b', { s: 0.9 }), candidate('c', { s: 0.5 })],
      { limit: 2 },
    );

    assert.deepEqual(
      results.map((r) => [r.rank, r.candidate.id]),
      [
        [1, 'b'],
        [2, 'c'],
      ],
    );
  });

  test('an empty candidate list ranks to an empty result', async () => {
    const ranker = createKnowledgeRanker(createWeightedRankingStrategy());

    assert.deepEqual(await ranker.rank('query', []), []);
  });

  test('rejects empty queries and invalid limits', async () => {
    const ranker = createKnowledgeRanker(createWeightedRankingStrategy());

    await assert.rejects(() => ranker.rank('  ', []), RankingValidationError);
    await assert.rejects(
      () => ranker.rank('query', [candidate('a', {})], { limit: 0 }),
      RankingValidationError,
    );
  });

  test('any conforming strategy plugs in', async () => {
    // A strategy that prefers SHORT ids — nothing weighted about it.
    const shortestIdFirst: RankingStrategy = {
      name: 'shortest-id',
      score: (_query, candidates) =>
        candidates.map((entry) => ({
          candidate: entry,
          score: 1 / entry.id.length,
          explanation: {
            strategy: 'shortest-id',
            contributions: [],
            summary: `1 / ${entry.id.length}`,
          },
        })),
    };
    const ranker = createKnowledgeRanker(shortestIdFirst);

    const results = await ranker.rank('query', [
      candidate('long-id', {}),
      candidate('ab', {}),
    ]);

    assert.equal(results[0]?.candidate.id, 'ab');
    assert.equal(ranker.getDiagnostics().strategy, 'shortest-id');
  });

  test('strategy failures are wrapped as typed errors and counted', async () => {
    const broken: RankingStrategy = {
      name: 'broken',
      score: () => {
        throw new Error('strategy exploded');
      },
    };
    const ranker = createKnowledgeRanker(broken);

    await assert.rejects(
      () => ranker.rank('query', [candidate('a', {})]),
      (error: unknown) =>
        error instanceof RankingStrategyError &&
        error.strategy === 'broken' &&
        error.message.includes('strategy exploded'),
    );
    assert.equal(ranker.getDiagnostics().failures, 1);
  });

  test('a strategy returning the wrong number of scores fails loudly', async () => {
    const lossy: RankingStrategy = {
      name: 'lossy',
      score: () => [],
    };
    const ranker = createKnowledgeRanker(lossy);

    await assert.rejects(
      () => ranker.rank('query', [candidate('a', {})]),
      /returned 0 scores for 1 candidates/,
    );
  });

  test('diagnostics aggregate across rankings', async () => {
    const ranker = createKnowledgeRanker(createWeightedRankingStrategy());

    await ranker.rank('one', [candidate('a', { s: 1 }), candidate('b', { s: 0 })]);
    await ranker.rank('two', [candidate('c', { s: 1 })]);

    assert.deepEqual(ranker.getDiagnostics(), {
      strategy: 'weighted',
      totalRankings: 2,
      totalCandidates: 3,
      failures: 0,
    });
  });
});

describe('hybrid retrieval adapter', () => {
  test('maps per-source scores to named signals and keeps the title', () => {
    const candidates = candidatesFromHybridResults([
      {
        id: 'a',
        text: 'content',
        title: 'Title',
        combinedScore: 0.75,
        keywordScore: 1,
        vectorScore: 0.5,
        sources: ['keyword', 'vector'],
      },
      {
        id: 'b',
        text: 'vector only',
        combinedScore: 0.25,
        keywordScore: 0,
        vectorScore: 0.5,
        sources: ['vector'],
      },
    ]);

    assert.deepEqual(candidates[0], {
      id: 'a',
      text: 'content',
      title: 'Title',
      signals: { keyword: 1, vector: 0.5 },
    });
    assert.equal(candidates[1]?.title, undefined);
    assert.deepEqual(candidates[1]?.signals, { keyword: 0, vector: 0.5 });
  });

  test('adapted results rank end-to-end through the weighted strategy', async () => {
    const ranker = createKnowledgeRanker(createWeightedRankingStrategy());

    const results = await ranker.rank(
      'query',
      candidatesFromHybridResults([
        {
          id: 'both',
          text: 'x',
          combinedScore: 1,
          keywordScore: 1,
          vectorScore: 1,
          sources: ['keyword', 'vector'],
        },
        {
          id: 'weak',
          text: 'y',
          combinedScore: 0.1,
          keywordScore: 0.2,
          vectorScore: 0,
          sources: ['keyword'],
        },
      ]),
    );

    assert.deepEqual(results.map((r) => r.candidate.id), ['both', 'weak']);
    assert.equal(results[0]?.score, 1);
  });
});
