import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryVectorStore } from './InMemoryVectorStore.ts';
import { SimilarityMetric } from './Similarity.ts';
import {
  DimensionMismatchError,
  DocumentNotFoundError,
  DuplicateDocumentError,
  VectorValidationError,
} from './VectorErrors.ts';
import type { VectorDocument } from './VectorDocument.ts';

function doc(
  id: string,
  vector: number[],
  metadata?: VectorDocument['metadata'],
): VectorDocument {
  const document: VectorDocument = { id, text: `text of ${id}`, vector };
  if (metadata) {
    document.metadata = metadata;
  }
  return document;
}

describe('add and get', () => {
  test('a stored document round-trips through get', async () => {
    const store = new InMemoryVectorStore();

    await store.add(doc('a', [1, 2, 3], { topic: 'testing' }));

    assert.deepEqual(await store.get('a'), {
      id: 'a',
      text: 'text of a',
      vector: [1, 2, 3],
      metadata: { topic: 'testing' },
    });
  });

  test('get returns undefined for an unknown id', async () => {
    const store = new InMemoryVectorStore();

    assert.equal(await store.get('missing'), undefined);
  });

  test('adding an existing id is rejected — update() is for replacing', async () => {
    const store = new InMemoryVectorStore();
    await store.add(doc('a', [1, 2]));

    await assert.rejects(() => store.add(doc('a', [3, 4])), DuplicateDocumentError);
  });

  test('documents are copied in and out — callers cannot corrupt the index', async () => {
    const store = new InMemoryVectorStore();
    const original = doc('a', [1, 2]);

    await store.add(original);
    original.vector[0] = 999; // caller mutates its own copy afterwards

    const stored = await store.get('a');
    assert.ok(stored);
    assert.deepEqual(stored.vector, [1, 2], 'write-side aliasing prevented');

    stored.vector[0] = 777; // caller mutates what get() returned
    assert.deepEqual((await store.get('a'))?.vector, [1, 2], 'read-side too');
  });
});

describe('addBatch', () => {
  test('inserts every document', async () => {
    const store = new InMemoryVectorStore();

    await store.addBatch([doc('a', [1, 0]), doc('b', [0, 1])]);

    assert.equal(store.getDiagnostics().documentCount, 2);
  });

  test('an empty batch is rejected', async () => {
    const store = new InMemoryVectorStore();

    await assert.rejects(() => store.addBatch([]), VectorValidationError);
  });

  test('validates the whole batch before inserting anything', async () => {
    const store = new InMemoryVectorStore();

    await assert.rejects(
      () => store.addBatch([doc('a', [1, 0]), doc('a', [0, 1])]),
      DuplicateDocumentError,
    );
    assert.equal(store.getDiagnostics().documentCount, 0, 'nothing half-committed');

    await assert.rejects(
      () => store.addBatch([doc('b', [1, 0]), doc('c', [1, 0, 0])]),
      DimensionMismatchError,
    );
    assert.equal(store.getDiagnostics().documentCount, 0);
  });
});

describe('update and delete', () => {
  test('update replaces an existing document', async () => {
    const store = new InMemoryVectorStore();
    await store.add(doc('a', [1, 2]));

    await store.update({ id: 'a', text: 'replaced', vector: [3, 4] });

    const stored = await store.get('a');
    assert.equal(stored?.text, 'replaced');
    assert.deepEqual(stored?.vector, [3, 4]);
  });

  test('update rejects unknown ids', async () => {
    const store = new InMemoryVectorStore();

    await assert.rejects(() => store.update(doc('ghost', [1])), DocumentNotFoundError);
  });

  test('delete removes a document; deleting again is an error', async () => {
    const store = new InMemoryVectorStore();
    await store.add(doc('a', [1, 2]));

    await store.delete('a');

    assert.equal(await store.get('a'), undefined);
    await assert.rejects(() => store.delete('a'), DocumentNotFoundError);
  });
});

describe('dimension validation', () => {
  test('the first document locks the dimensions for all that follow', async () => {
    const store = new InMemoryVectorStore();
    await store.add(doc('a', [1, 2, 3]));

    await assert.rejects(() => store.add(doc('b', [1, 2])), DimensionMismatchError);
    await assert.rejects(() => store.search([1, 2]), DimensionMismatchError);
    await assert.rejects(
      () => store.update({ id: 'a', text: 'x', vector: [1, 2] }),
      DimensionMismatchError,
    );
  });

  test('emptying the store releases the dimension lock', async () => {
    const store = new InMemoryVectorStore();
    await store.add(doc('a', [1, 2, 3]));

    await store.delete('a');
    await store.add(doc('b', [1, 2])); // new dimensionality accepted

    assert.equal(store.getDiagnostics().dimensions, 2);
  });

  test('clear() also releases the lock', async () => {
    const store = new InMemoryVectorStore();
    await store.add(doc('a', [1, 2, 3]));

    await store.clear();

    assert.equal(store.getDiagnostics().dimensions, undefined);
    await store.add(doc('b', [1]));
  });
});

describe('input validation', () => {
  test('rejects empty ids, malformed vectors, and non-primitive metadata', async () => {
    const store = new InMemoryVectorStore();

    await assert.rejects(() => store.add(doc('', [1])), VectorValidationError);
    await assert.rejects(() => store.add(doc('a', [])), VectorValidationError);
    await assert.rejects(() => store.add(doc('a', [Number.NaN])), VectorValidationError);
    await assert.rejects(
      () =>
        store.add({
          id: 'a',
          text: 'x',
          vector: [1],
          metadata: { nested: { deep: true } } as never,
        }),
      VectorValidationError,
    );
  });

  test('search rejects malformed query vectors and topK', async () => {
    const store = new InMemoryVectorStore();
    await store.add(doc('a', [1, 2]));

    await assert.rejects(() => store.search([]), VectorValidationError);
    await assert.rejects(() => store.search([1, 2], { topK: 0 }), VectorValidationError);
    await assert.rejects(() => store.search([1, 2], { topK: 1.5 }), VectorValidationError);
  });
});

describe('search', () => {
  // Unit vectors at known angles from the query [1, 0]: the expected
  // cosine ranking is c (identical) > b (45 deg) > a (90 deg).
  async function seededStore(): Promise<InMemoryVectorStore> {
    const store = new InMemoryVectorStore();
    await store.addBatch([
      doc('a', [0, 1], { lang: 'en', year: 2024 }),
      doc('b', [Math.SQRT1_2, Math.SQRT1_2], { lang: 'de', year: 2024 }),
      doc('c', [1, 0], { lang: 'en', year: 2025 }),
    ]);
    return store;
  }

  test('ranks by cosine similarity, best first, and honors topK', async () => {
    const store = await seededStore();

    const results = await store.search([1, 0], { topK: 2 });

    assert.deepEqual(
      results.map((result) => result.document.id),
      ['c', 'b'],
    );
    assert.equal(results[0]?.score, 1);
    assert.equal(results[0]?.metric, SimilarityMetric.Cosine);
  });

  test('topK defaults to 5 and never exceeds the corpus', async () => {
    const store = await seededStore();

    const results = await store.search([1, 0]);

    assert.equal(results.length, 3);
  });

  test('dot product rewards magnitude', async () => {
    const store = new InMemoryVectorStore();
    await store.addBatch([doc('small', [1, 0]), doc('large', [10, 0])]);

    const results = await store.search([1, 0], {
      metric: SimilarityMetric.DotProduct,
    });

    assert.equal(results[0]?.document.id, 'large');
  });

  test('euclidean ranks the geometrically closest first', async () => {
    const store = new InMemoryVectorStore();
    await store.addBatch([doc('near', [1, 1]), doc('far', [10, 10])]);

    const results = await store.search([0, 0], {
      metric: SimilarityMetric.Euclidean,
    });

    assert.equal(results[0]?.document.id, 'near');
    assert.ok(results.every((result) => result.score > 0 && result.score <= 1));
  });

  test('metadata filters are AND-ed equality checks', async () => {
    const store = await seededStore();

    const en = await store.search([1, 0], { filter: { lang: 'en' } });
    assert.deepEqual(en.map((result) => result.document.id), ['c', 'a']);

    const en2024 = await store.search([1, 0], {
      filter: { lang: 'en', year: 2024 },
    });
    assert.deepEqual(en2024.map((result) => result.document.id), ['a']);
  });

  test('documents without metadata never match a non-empty filter', async () => {
    const store = new InMemoryVectorStore();
    await store.add(doc('bare', [1, 0]));

    const results = await store.search([1, 0], { filter: { lang: 'en' } });

    assert.deepEqual(results, []);
  });
});

describe('diagnostics', () => {
  test('counts documents, adds, searches and deletes', async () => {
    const store = new InMemoryVectorStore();

    await store.addBatch([doc('a', [1, 0]), doc('b', [0, 1])]);
    await store.add(doc('c', [1, 1]));
    await store.search([1, 0]);
    await store.search([0, 1]);
    await store.delete('a');

    assert.deepEqual(store.getDiagnostics(), {
      documentCount: 2,
      dimensions: 2,
      totalDocumentsAdded: 3,
      totalSearches: 2,
      totalDeletes: 1,
    });
  });

  test('lifetime counters survive clear()', async () => {
    const store = new InMemoryVectorStore();
    await store.add(doc('a', [1]));
    await store.search([1]);

    await store.clear();

    const diagnostics = store.getDiagnostics();
    assert.equal(diagnostics.documentCount, 0);
    assert.equal(diagnostics.totalDocumentsAdded, 1);
    assert.equal(diagnostics.totalSearches, 1);
  });
});
