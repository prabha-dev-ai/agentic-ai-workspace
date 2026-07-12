import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresVectorStore } from './PostgresVectorStore.ts';
import { DimensionMismatchError, DocumentNotFoundError, DuplicateDocumentError, VectorValidationError } from './VectorErrors.ts';
import { SimilarityMetric } from './Similarity.ts';
import type { PgClient, PgQueryResult } from '../database/PgClient.ts';
import type { VectorDocument } from './VectorDocument.ts';

// An in-memory stand-in for `pg.Pool` that speaks just enough SQL to back
// PostgresVectorStore's queries — no real database, same injected-fake
// idiom as EmbeddingProvider.test.ts's fake OpenAI client. It models
// pgvector's real behavior (distance operators, unique-violation error
// code 23505) closely enough to exercise the store's logic honestly.
function makeFakeClient(dimensions: number): PgClient {
  const rows = new Map<string, { id: string; text: string; vector: number[]; metadata: VectorDocument['metadata'] | null }>();

  function cosineDistance(a: number[], b: number[]): number {
    const dot = a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);
    const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
    if (magA === 0 || magB === 0) return 1;
    return 1 - dot / (magA * magB);
  }

  function parseVectorLiteral(literal: string): number[] {
    return literal.slice(1, -1).split(',').map(Number);
  }

  return {
    async query<Row>(text: string, params: unknown[] = []): Promise<PgQueryResult<Row>> {
      const sql = text.trim();

      if (sql.startsWith('CREATE EXTENSION') || sql.startsWith('CREATE TABLE')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.startsWith('SELECT COUNT')) {
        return { rows: [{ count: String(rows.size) }] as Row[], rowCount: 1 };
      }

      if (sql.startsWith('INSERT INTO')) {
        const [id, doc, vectorLiteral, metadata] = params as [string, string, string, VectorDocument['metadata'] | null];
        if (rows.has(id)) {
          const error = new Error('duplicate key value violates unique constraint') as Error & { code: string };
          error.code = '23505';
          throw error;
        }
        rows.set(id, { id, text: doc, vector: parseVectorLiteral(vectorLiteral), metadata });
        return { rows: [], rowCount: 1 };
      }

      if (sql.startsWith('UPDATE')) {
        const [id, doc, vectorLiteral, metadata] = params as [string, string, string, VectorDocument['metadata'] | null];
        if (!rows.has(id)) {
          return { rows: [], rowCount: 0 };
        }
        rows.set(id, { id, text: doc, vector: parseVectorLiteral(vectorLiteral), metadata });
        return { rows: [], rowCount: 1 };
      }

      if (sql.startsWith('DELETE FROM') && sql.includes('WHERE id')) {
        const [id] = params as [string];
        const existed = rows.delete(id);
        return { rows: [], rowCount: existed ? 1 : 0 };
      }

      if (sql.startsWith('DELETE FROM')) {
        rows.clear();
        return { rows: [], rowCount: 0 };
      }

      if (sql.startsWith('SELECT id, text, vector::text AS vector, metadata FROM')) {
        const [id] = params as [string];
        const row = rows.get(id);
        return {
          rows: row ? [{ id: row.id, text: row.text, vector: `[${row.vector.join(',')}]`, metadata: row.metadata }] as Row[] : [],
          rowCount: row ? 1 : 0,
        };
      }

      if (sql.includes('ORDER BY vector')) {
        const [vectorLiteral] = params as [string];
        const queryVector = parseVectorLiteral(vectorLiteral);

        let filterMetadata: VectorDocument['metadata'] | undefined;
        if (sql.includes('metadata @>')) {
          filterMetadata = JSON.parse(params[1] as string);
        }
        const topK = Number(params.at(-1));

        let candidates = [...rows.values()];
        if (filterMetadata) {
          candidates = candidates.filter((row) =>
            Object.entries(filterMetadata!).every(([key, value]) => row.metadata?.[key] === value),
          );
        }

        const scored = candidates
          .map((row) => ({ row, distance: cosineDistance(queryVector, row.vector) }))
          .sort((a, b) => a.distance - b.distance)
          .slice(0, topK);

        return {
          rows: scored.map(({ row, distance }) => ({
            id: row.id,
            text: row.text,
            vector: `[${row.vector.join(',')}]`,
            metadata: row.metadata,
            distance,
          })) as Row[],
          rowCount: scored.length,
        };
      }

      throw new Error(`Unhandled fake query: ${sql}`);
    },
  };
}

async function makeStore(dimensions = 2): Promise<PostgresVectorStore> {
  const store = new PostgresVectorStore(makeFakeClient(dimensions), { dimensions });
  await store.connect();
  return store;
}

describe('PostgresVectorStore: validation', () => {
  test('rejects a non-positive dimensions option', () => {
    assert.throws(() => new PostgresVectorStore(makeFakeClient(2), { dimensions: 0 }), VectorValidationError);
  });

  test('using the store before connect() rejects', async () => {
    const store = new PostgresVectorStore(makeFakeClient(2), { dimensions: 2 });
    await assert.rejects(() => store.add({ id: 'a', text: 'a', vector: [1, 0] }), VectorValidationError);
  });
});

describe('PostgresVectorStore: CRUD', () => {
  test('add then get round-trips a document', async () => {
    const store = await makeStore();
    await store.add({ id: 'doc-1', text: 'hello', vector: [1, 0], metadata: { lang: 'en' } });

    const found = await store.get('doc-1');
    assert.equal(found?.text, 'hello');
    assert.deepEqual(found?.vector, [1, 0]);
    assert.deepEqual(found?.metadata, { lang: 'en' });
  });

  test('adding a duplicate id fails', async () => {
    const store = await makeStore();
    await store.add({ id: 'doc-1', text: 'a', vector: [1, 0] });

    await assert.rejects(() => store.add({ id: 'doc-1', text: 'b', vector: [0, 1] }), DuplicateDocumentError);
  });

  test('a vector with the wrong dimension count is rejected', async () => {
    const store = await makeStore();
    await assert.rejects(() => store.add({ id: 'doc-1', text: 'a', vector: [1, 0, 0] }), DimensionMismatchError);
  });

  test('update replaces an existing document', async () => {
    const store = await makeStore();
    await store.add({ id: 'doc-1', text: 'old', vector: [1, 0] });
    await store.update({ id: 'doc-1', text: 'new', vector: [0, 1] });

    assert.equal((await store.get('doc-1'))?.text, 'new');
  });

  test('update on an unknown id fails', async () => {
    const store = await makeStore();
    await assert.rejects(() => store.update({ id: 'missing', text: 'x', vector: [1, 0] }), DocumentNotFoundError);
  });

  test('delete removes a document', async () => {
    const store = await makeStore();
    await store.add({ id: 'doc-1', text: 'a', vector: [1, 0] });
    await store.delete('doc-1');

    assert.equal(await store.get('doc-1'), undefined);
  });

  test('delete on an unknown id fails', async () => {
    const store = await makeStore();
    await assert.rejects(() => store.delete('missing'), DocumentNotFoundError);
  });

  test('addBatch validates every document before inserting any', async () => {
    const store = await makeStore();

    await assert.rejects(
      () =>
        store.addBatch([
          { id: 'a', text: 'a', vector: [1, 0] },
          { id: 'a', text: 'dup', vector: [0, 1] },
        ]),
      DuplicateDocumentError,
    );

    assert.equal(await store.get('a'), undefined, 'nothing was committed from the failed batch');
  });

  test('clear empties the table', async () => {
    const store = await makeStore();
    await store.add({ id: 'a', text: 'a', vector: [1, 0] });
    await store.clear();

    assert.equal(await store.get('a'), undefined);
    assert.equal(store.getDiagnostics().documentCount, 0);
  });
});

describe('PostgresVectorStore: search', () => {
  test('search ranks by cosine similarity, best first', async () => {
    const store = await makeStore();
    await store.addBatch([
      { id: 'close', text: 'close', vector: [1, 0] },
      { id: 'far', text: 'far', vector: [0, 1] },
    ]);

    const results = await store.search([1, 0], { topK: 2 });

    assert.equal(results[0]?.document.id, 'close');
    assert.ok((results[0]?.score ?? 0) > (results[1]?.score ?? 0));
  });

  test('a metadata filter is applied before the topK limit, not after', async () => {
    const store = await makeStore();
    // Three documents all very close to the query; only one matches the
    // filter. If the filter were applied client-side after LIMIT 1, the
    // matching document could be dropped entirely.
    await store.addBatch([
      { id: 'a', text: 'a', vector: [1, 0], metadata: { tag: 'other' } },
      { id: 'b', text: 'b', vector: [0.99, 0.01], metadata: { tag: 'other' } },
      { id: 'target', text: 'target', vector: [0.98, 0.02], metadata: { tag: 'wanted' } },
    ]);

    const results = await store.search([1, 0], { topK: 1, filter: { tag: 'wanted' } });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.document.id, 'target');
  });

  test('an invalid topK is rejected', async () => {
    const store = await makeStore();
    await assert.rejects(() => store.search([1, 0], { topK: 0 }), VectorValidationError);
  });

  test('dot-product and euclidean metrics are both supported', async () => {
    const store = await makeStore();
    await store.add({ id: 'a', text: 'a', vector: [1, 0] });

    const dot = await store.search([1, 0], { metric: SimilarityMetric.DotProduct });
    const euclid = await store.search([1, 0], { metric: SimilarityMetric.Euclidean });

    assert.equal(dot[0]?.metric, SimilarityMetric.DotProduct);
    assert.equal(euclid[0]?.metric, SimilarityMetric.Euclidean);
  });
});

describe('PostgresVectorStore: diagnostics', () => {
  test('tracks counts across add/delete/search', async () => {
    const store = await makeStore();
    await store.add({ id: 'a', text: 'a', vector: [1, 0] });
    await store.add({ id: 'b', text: 'b', vector: [0, 1] });
    await store.search([1, 0]);
    await store.delete('a');

    const diagnostics = store.getDiagnostics();
    assert.equal(diagnostics.documentCount, 1);
    assert.equal(diagnostics.totalDocumentsAdded, 2);
    assert.equal(diagnostics.totalSearches, 1);
    assert.equal(diagnostics.totalDeletes, 1);
  });

  test('connect() primes documentCount from existing rows', async () => {
    const client = makeFakeClient(2);
    const first = new PostgresVectorStore(client, { dimensions: 2 });
    await first.connect();
    await first.add({ id: 'a', text: 'a', vector: [1, 0] });

    // A second store instance over the SAME client simulates reconnecting
    // to a table that already has data — e.g. a process restart.
    const second = new PostgresVectorStore(client, { dimensions: 2 });
    await second.connect();

    assert.equal(second.getDiagnostics().documentCount, 1);
  });
});
