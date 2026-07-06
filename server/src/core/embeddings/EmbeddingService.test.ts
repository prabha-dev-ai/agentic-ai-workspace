import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EmbeddingService } from './EmbeddingService.ts';
import {
  EmbeddingProviderError,
  EmbeddingValidationError,
} from './EmbeddingErrors.ts';
import type { EmbeddingProvider } from './EmbeddingProvider.ts';

// A deterministic in-memory provider: each text becomes a 3-dimensional
// vector derived from its length, and every provider call is recorded so
// tests can assert batching behavior.
function makeProvider(overrides: Partial<EmbeddingProvider> = {}) {
  const batchCalls: string[][] = [];

  const provider: EmbeddingProvider & { batchCalls: string[][] } = {
    batchCalls,
    model: { name: 'fake-model', dimensions: 3 },
    async embed(text) {
      return [text.length, 0, 1];
    },
    async embedBatch(texts) {
      batchCalls.push([...texts]);
      return texts.map((text) => [text.length, 0, 1]);
    },
    ...overrides,
  };

  return provider;
}

describe('single embedding', () => {
  test('embed returns a normalized result with provenance', async () => {
    const service = new EmbeddingService(makeProvider());

    const result = await service.embed('hello');

    assert.deepEqual(result, {
      text: 'hello',
      vector: [5, 0, 1],
      model: 'fake-model',
      dimensions: 3,
    });
  });
});

describe('batch embedding', () => {
  test('embedBatch preserves input order across chunks', async () => {
    const service = new EmbeddingService(makeProvider(), { batchSize: 2 });

    const results = await service.embedBatch(['a', 'bb', 'ccc', 'dddd', 'eeeee']);

    assert.deepEqual(
      results.map((result) => result.text),
      ['a', 'bb', 'ccc', 'dddd', 'eeeee'],
    );
    assert.deepEqual(results[0]?.vector, [1, 0, 1]);
    assert.deepEqual(results[4]?.vector, [5, 0, 1]);
  });

  test('embedBatch chunks provider calls by batchSize', async () => {
    const provider = makeProvider();
    const service = new EmbeddingService(provider, { batchSize: 2 });

    await service.embedBatch(['a', 'b', 'c', 'd', 'e']);

    assert.deepEqual(provider.batchCalls, [['a', 'b'], ['c', 'd'], ['e']]);
  });
});

describe('validation', () => {
  test('embed rejects empty and whitespace-only text', async () => {
    const service = new EmbeddingService(makeProvider());

    await assert.rejects(() => service.embed(''), EmbeddingValidationError);
    await assert.rejects(() => service.embed('   '), EmbeddingValidationError);
  });

  test('embedBatch rejects an empty list', async () => {
    const service = new EmbeddingService(makeProvider());

    await assert.rejects(() => service.embedBatch([]), EmbeddingValidationError);
  });

  test('embedBatch validates every text before the first provider call', async () => {
    const provider = makeProvider();
    const service = new EmbeddingService(provider);

    await assert.rejects(
      () => service.embedBatch(['fine', '', 'also fine']),
      EmbeddingValidationError,
    );
    assert.deepEqual(provider.batchCalls, [], 'no API spend on invalid input');
  });

  test('a batchSize below 1 is rejected at construction', () => {
    assert.throws(
      () => new EmbeddingService(makeProvider(), { batchSize: 0 }),
      EmbeddingValidationError,
    );
  });
});

describe('provider failures', () => {
  test('unknown provider errors are wrapped as EmbeddingProviderError', async () => {
    const provider = makeProvider({
      embed: async () => {
        throw new Error('socket hang up');
      },
    });
    const service = new EmbeddingService(provider);

    await assert.rejects(
      () => service.embed('hello'),
      (error: unknown) =>
        error instanceof EmbeddingProviderError &&
        error.model === 'fake-model' &&
        error.message.includes('socket hang up'),
    );
  });

  test('a vector count mismatch fails the batch', async () => {
    const provider = makeProvider({
      embedBatch: async () => [[1, 0, 1]],
    });
    const service = new EmbeddingService(provider);

    await assert.rejects(
      () => service.embedBatch(['a', 'b']),
      EmbeddingProviderError,
    );
  });

  test('an empty vector never leaves the service', async () => {
    const provider = makeProvider({ embed: async () => [] });
    const service = new EmbeddingService(provider);

    await assert.rejects(() => service.embed('hello'), EmbeddingProviderError);
  });

  test('non-finite vector values never leave the service', async () => {
    const provider = makeProvider({ embed: async () => [1, Number.NaN, 3] });
    const service = new EmbeddingService(provider);

    await assert.rejects(() => service.embed('hello'), EmbeddingProviderError);
  });

  test('a dimension mismatch against the declared model fails', async () => {
    const provider = makeProvider({ embed: async () => [1, 2] });
    const service = new EmbeddingService(provider);

    await assert.rejects(
      () => service.embed('hello'),
      /returned 2 dimensions, expected 3/,
    );
  });
});

describe('diagnostics', () => {
  test('counters reflect requests, texts, provider calls and failures', async () => {
    const service = new EmbeddingService(makeProvider(), { batchSize: 2 });

    await service.embed('one');
    await service.embedBatch(['a', 'b', 'c']);

    assert.deepEqual(service.getDiagnostics(), {
      totalRequests: 2,
      totalTexts: 4,
      providerCalls: 3, // 1 single + 2 chunks
      failures: 0,
    });
  });

  test('failures are counted', async () => {
    const provider = makeProvider({
      embed: async () => {
        throw new Error('down');
      },
    });
    const service = new EmbeddingService(provider);

    await assert.rejects(() => service.embed('hello'));

    assert.equal(service.getDiagnostics().failures, 1);
  });
});
