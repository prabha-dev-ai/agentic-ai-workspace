import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RetrievalSource,
  RetrievalValidationError,
  createHybridRetriever,
} from './hybrid-retriever.ts';
import { createKnowledgeStore } from './knowledge-store.ts';
import { EmbeddingService, EmbeddingProviderError } from '../core/embeddings/index.ts';
import { InMemoryVectorStore } from '../core/vectorstore/index.ts';

// Real knowledge store, real vector store, real embedding service — only
// the embedding PROVIDER is fake, mapping every text to a fixed vector.
// The fusion is tested against the actual components it composes.
function makeEmbedder(vectorFor: (text: string) => number[]): EmbeddingService {
  return new EmbeddingService({
    model: { name: 'fake-embed', dimensions: 2 },
    embed: async (text) => vectorFor(text),
    embedBatch: async (texts) => texts.map(vectorFor),
  });
}

function makeDeps(vectorFor: (text: string) => number[] = () => [1, 0]) {
  return {
    knowledgeStore: createKnowledgeStore(),
    embeddingService: makeEmbedder(vectorFor),
    vectorStore: new InMemoryVectorStore(),
  };
}

describe('hybrid fusion', () => {
  test('a document found by both sources outranks single-source documents', async () => {
    const deps = makeDeps(() => [1, 0]);
    deps.knowledgeStore.add({
      id: 'ts',
      title: 'TypeScript Guide',
      content: 'typescript strict mode compiler',
    });
    deps.knowledgeStore.add({
      id: 'js',
      title: 'JavaScript Basics',
      content: 'javascript runtime fundamentals',
    });
    await deps.vectorStore.addBatch([
      { id: 'ts', text: 'typescript strict mode compiler', vector: [1, 0] },
      { id: 'cooking', text: 'cooking pasta sauce', vector: [0, 1] },
    ]);
    const retriever = createHybridRetriever(deps);

    const results = await retriever.retrieve('typescript basics');

    assert.equal(results[0]?.id, 'ts', 'dual-source evidence wins');
    assert.deepEqual(results[0]?.sources, [
      RetrievalSource.Keyword,
      RetrievalSource.Vector,
    ]);

    const topScore = results[0]?.combinedScore ?? 0;
    for (const result of results.slice(1)) {
      assert.ok(result.combinedScore < topScore, `${result.id} must rank below ts`);
    }
  });

  test('documents from either source appear once, merged by id', async () => {
    const deps = makeDeps(() => [1, 0]);
    deps.knowledgeStore.add({ id: 'a', title: 'Quantum', content: 'quantum research' });
    await deps.vectorStore.add({ id: 'a', text: 'quantum research', vector: [1, 0] });
    const retriever = createHybridRetriever(deps);

    const results = await retriever.retrieve('quantum');

    assert.equal(results.length, 1, 'no duplicate entries for the same id');
    assert.equal(results[0]?.keywordScore, 1);
    assert.equal(results[0]?.vectorScore, 1);
    assert.equal(results[0]?.combinedScore, 1); // 0.5 * 1 + 0.5 * 1
  });

  test('a knowledge-store hit carries its title; a vector-only hit does not', async () => {
    const deps = makeDeps(() => [1, 0]);
    deps.knowledgeStore.add({ id: 'kw', title: 'Quantum', content: 'quantum research' });
    await deps.vectorStore.add({ id: 'vec', text: 'vector only text', vector: [1, 0] });
    const retriever = createHybridRetriever(deps);

    const results = await retriever.retrieve('quantum');
    const keywordHit = results.find((r) => r.id === 'kw');
    const vectorHit = results.find((r) => r.id === 'vec');

    assert.equal(keywordHit?.title, 'Quantum');
    assert.equal(keywordHit?.text, 'quantum research');
    assert.equal(vectorHit?.title, undefined);
    assert.equal(vectorHit?.text, 'vector only text');
  });
});

describe('configurable weights', () => {
  async function seededRetrieve(weights: { keywordWeight: number; vectorWeight: number }) {
    const deps = makeDeps(() => [1, 0]);
    deps.knowledgeStore.add({ id: 'kw-doc', title: 'Alpha', content: 'quantum research' });
    await deps.vectorStore.add({ id: 'v-doc', text: 'semantically close', vector: [1, 0] });

    const retriever = createHybridRetriever(deps, weights);
    return retriever.retrieve('quantum research');
  }

  test('all weight on keyword ranks the keyword hit first', async () => {
    const results = await seededRetrieve({ keywordWeight: 1, vectorWeight: 0 });

    assert.deepEqual(results.map((r) => r.id), ['kw-doc', 'v-doc']);
    assert.equal(results[0]?.combinedScore, 1);
    assert.equal(results[1]?.combinedScore, 0);
  });

  test('all weight on vector ranks the vector hit first', async () => {
    const results = await seededRetrieve({ keywordWeight: 0, vectorWeight: 1 });

    assert.deepEqual(results.map((r) => r.id), ['v-doc', 'kw-doc']);
  });

  test('invalid weights are rejected at construction', () => {
    const deps = makeDeps();

    assert.throws(
      () => createHybridRetriever(deps, { keywordWeight: -1 }),
      RetrievalValidationError,
    );
    assert.throws(
      () => createHybridRetriever(deps, { keywordWeight: 0, vectorWeight: 0 }),
      RetrievalValidationError,
    );
  });
});

describe('score normalization', () => {
  test('each source is min-max normalized into [0, 1] before weighting', async () => {
    const deps = makeDeps(() => [1, 0]);
    // Distinct keyword strengths: title hits count double.
    deps.knowledgeStore.add({ id: 'high', title: 'Quantum Physics', content: 'research overview' });
    deps.knowledgeStore.add({ id: 'mid', title: 'Physics', content: 'general notes' });
    deps.knowledgeStore.add({ id: 'low', title: 'Misc', content: 'research notes' });
    const retriever = createHybridRetriever(deps);

    const results = await retriever.retrieve('quantum physics research');
    const byId = new Map(results.map((r) => [r.id, r]));

    assert.equal(byId.get('high')?.keywordScore, 1, 'best candidate normalizes to 1');
    assert.equal(byId.get('low')?.keywordScore, 0, 'worst candidate normalizes to 0');
    const mid = byId.get('mid')?.keywordScore ?? -1;
    assert.ok(mid > 0 && mid < 1, `middle candidate stays between (got ${mid})`);
  });

  test('a single candidate (or all-equal scores) counts fully instead of 0/0', async () => {
    const deps = makeDeps(() => [1, 0]);
    deps.knowledgeStore.add({ id: 'only', title: 'Quantum', content: 'quantum' });
    const retriever = createHybridRetriever(deps);

    const results = await retriever.retrieve('quantum');

    assert.equal(results[0]?.keywordScore, 1);
    assert.ok(Number.isFinite(results[0]?.combinedScore ?? Number.NaN), 'never NaN');
  });
});

describe('limits and validation', () => {
  test('returns at most limit results (default 3)', async () => {
    const deps = makeDeps(() => [1, 0]);
    for (const id of ['a', 'b', 'c', 'd']) {
      deps.knowledgeStore.add({ id, title: `Quantum ${id}`, content: 'quantum' });
    }
    const retriever = createHybridRetriever(deps);

    assert.equal((await retriever.retrieve('quantum')).length, 3);
    assert.equal((await retriever.retrieve('quantum', { limit: 2 })).length, 2);
  });

  test('rejects empty queries and non-positive limits', async () => {
    const retriever = createHybridRetriever(makeDeps());

    await assert.rejects(() => retriever.retrieve('   '), RetrievalValidationError);
    await assert.rejects(
      () => retriever.retrieve('quantum', { limit: 0 }),
      RetrievalValidationError,
    );
  });
});

describe('vector side behavior', () => {
  test('an empty vector store skips the embedding call entirely', async () => {
    const deps = makeDeps(() => {
      throw new Error('embed must not be called for an empty vector store');
    });
    deps.knowledgeStore.add({ id: 'kw', title: 'Quantum', content: 'quantum' });
    const retriever = createHybridRetriever(deps);

    const results = await retriever.retrieve('quantum');

    assert.equal(results[0]?.id, 'kw', 'keyword results still returned');
    assert.equal(retriever.getDiagnostics().vectorSearchesSkipped, 1);
    assert.equal(retriever.getDiagnostics().vectorCandidates, 0);
  });

  test('embedding failures propagate as typed errors and are counted', async () => {
    const deps = makeDeps(() => {
      throw new Error('provider down');
    });
    await deps.vectorStore.add({ id: 'v', text: 'x', vector: [1, 0] });
    const retriever = createHybridRetriever(deps);

    await assert.rejects(() => retriever.retrieve('quantum'), EmbeddingProviderError);
    assert.equal(retriever.getDiagnostics().failures, 1);
  });
});

describe('determinism', () => {
  test('equal combined scores break ties by id', async () => {
    const deps = makeDeps(() => [1, 0]);
    deps.knowledgeStore.add({ id: 'zeta', title: 'Quantum', content: 'quantum' });
    deps.knowledgeStore.add({ id: 'alpha', title: 'Quantum', content: 'quantum' });
    const retriever = createHybridRetriever(deps);

    const results = await retriever.retrieve('quantum');

    assert.deepEqual(results.map((r) => r.id), ['alpha', 'zeta']);
  });
});

describe('diagnostics', () => {
  test('counters aggregate across queries', async () => {
    const deps = makeDeps(() => [1, 0]);
    deps.knowledgeStore.add({ id: 'kw', title: 'Quantum', content: 'quantum' });
    await deps.vectorStore.add({ id: 'v', text: 'x', vector: [1, 0] });
    const retriever = createHybridRetriever(deps);

    await retriever.retrieve('quantum');
    await retriever.retrieve('quantum physics');

    assert.deepEqual(retriever.getDiagnostics(), {
      totalQueries: 2,
      keywordCandidates: 2, // 'kw' found by both queries
      vectorCandidates: 2, // 'v' found by both queries
      vectorSearchesSkipped: 0,
      failures: 0,
    });
  });
});
