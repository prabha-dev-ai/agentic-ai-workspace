import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIEmbeddingProvider } from './EmbeddingProvider.ts';
import { DEFAULT_EMBEDDING_MODEL } from './EmbeddingModel.ts';
import { EmbeddingProviderError } from './EmbeddingErrors.ts';
import type OpenAI from 'openai';

// A fake OpenAI client covering only the /embeddings surface the provider
// touches. The cast is confined to this factory.
function makeFakeClient(
  data: { index: number; embedding: number[] }[],
  captured: unknown[] = [],
): OpenAI {
  const fake = {
    embeddings: {
      create: async (params: unknown) => {
        captured.push(params);
        return { data };
      },
    },
  };

  return fake as unknown as OpenAI;
}

describe('OpenAIEmbeddingProvider', () => {
  test('uses the default model unless one is given', () => {
    const provider = new OpenAIEmbeddingProvider(makeFakeClient([]));

    assert.deepEqual(provider.model, DEFAULT_EMBEDDING_MODEL);
  });

  test('embed sends the model and text, and returns the vector', async () => {
    const captured: unknown[] = [];
    const client = makeFakeClient([{ index: 0, embedding: [1, 2, 3] }], captured);
    const provider = new OpenAIEmbeddingProvider(client, { name: 'my-model' });

    const vector = await provider.embed('hello');

    assert.deepEqual(vector, [1, 2, 3]);
    assert.deepEqual(captured, [{ model: 'my-model', input: 'hello' }]);
  });

  test('embed fails when the response contains no embedding', async () => {
    const provider = new OpenAIEmbeddingProvider(makeFakeClient([]));

    await assert.rejects(() => provider.embed('hello'), EmbeddingProviderError);
  });

  test('embedBatch restores input order using the index field', async () => {
    // The API is allowed to answer out of order — only index is reliable.
    const client = makeFakeClient([
      { index: 1, embedding: [2, 2] },
      { index: 0, embedding: [1, 1] },
    ]);
    const provider = new OpenAIEmbeddingProvider(client, { name: 'm' });

    const vectors = await provider.embedBatch(['first', 'second']);

    assert.deepEqual(vectors, [[1, 1], [2, 2]]);
  });

  test('embedBatch fails on a count mismatch', async () => {
    const client = makeFakeClient([{ index: 0, embedding: [1] }]);
    const provider = new OpenAIEmbeddingProvider(client, { name: 'm' });

    await assert.rejects(
      () => provider.embedBatch(['a', 'b']),
      /expected 2 embeddings, received 1/,
    );
  });
});
