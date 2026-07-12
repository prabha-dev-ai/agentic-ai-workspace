import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresKnowledgeStore, KnowledgeStoreError } from './postgres-knowledge-store.ts';
import { createAsyncKnowledgeStorePlugin } from './async-knowledge-store-plugin.ts';
import { PluginLoader, PluginRegistry, PluginCapability } from '../core/plugins/index.ts';
import type { PgClient, PgQueryResult } from '../core/database/PgClient.ts';

// A minimal in-memory stand-in for `pg.Pool`, same idiom used throughout
// AAI-036's other Postgres-backed stores.
function makeFakeClient(): PgClient {
  const rows = new Map<string, { id: string; title: string; content: string }>();

  return {
    async query<Row>(text: string, params: unknown[] = []): Promise<PgQueryResult<Row>> {
      const sql = text.trim();

      if (sql.startsWith('CREATE TABLE')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.startsWith('INSERT INTO')) {
        const [id, title, content] = params as [string, string, string];
        if (rows.has(id)) {
          const error = new Error('duplicate key value violates unique constraint') as Error & { code: string };
          error.code = '23505';
          throw error;
        }
        rows.set(id, { id, title, content });
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('WHERE id')) {
        const [id] = params as [string];
        const row = rows.get(id);
        return { rows: row ? [row] as Row[] : [], rowCount: row ? 1 : 0 };
      }

      if (sql.startsWith('SELECT id, title, content FROM')) {
        return { rows: [...rows.values()] as Row[], rowCount: rows.size };
      }

      throw new Error(`Unhandled fake query: ${sql}`);
    },
  };
}

async function makeStore(): Promise<PostgresKnowledgeStore> {
  const store = new PostgresKnowledgeStore(makeFakeClient());
  await store.connect();
  return store;
}

describe('PostgresKnowledgeStore', () => {
  test('using the store before connect() rejects', async () => {
    const store = new PostgresKnowledgeStore(makeFakeClient());
    await assert.rejects(() => store.getAll(), KnowledgeStoreError);
  });

  test('add then getById round-trips a document', async () => {
    const store = await makeStore();
    await store.add({ id: 'doc-1', title: 'Doc 1', content: 'hello' });

    const found = await store.getById('doc-1');
    assert.deepEqual(found, { id: 'doc-1', title: 'Doc 1', content: 'hello' });
  });

  test('getById on a missing id returns undefined', async () => {
    const store = await makeStore();
    assert.equal(await store.getById('missing'), undefined);
  });

  test('getAll returns every stored document', async () => {
    const store = await makeStore();
    await store.add({ id: 'a', title: 'A', content: 'a content' });
    await store.add({ id: 'b', title: 'B', content: 'b content' });

    const all = await store.getAll();
    assert.equal(all.length, 2);
  });

  test('an empty id is rejected', async () => {
    const store = await makeStore();
    await assert.rejects(() => store.add({ id: '  ', title: 'x', content: 'x' }), KnowledgeStoreError);
  });

  test('empty content is rejected', async () => {
    const store = await makeStore();
    await assert.rejects(() => store.add({ id: 'a', title: 'x', content: '  ' }), KnowledgeStoreError);
  });

  test('a duplicate id is rejected as data loss, not silently overwritten', async () => {
    const store = await makeStore();
    await store.add({ id: 'a', title: 'first', content: 'first' });

    await assert.rejects(() => store.add({ id: 'a', title: 'second', content: 'second' }), KnowledgeStoreError);
    assert.equal((await store.getById('a'))?.title, 'first');
  });
});

describe('async knowledge store plugin capability', () => {
  test('declares the async-knowledge-store-provider capability', () => {
    const plugin = createAsyncKnowledgeStorePlugin(() => ({
      add: async () => {},
      getAll: async () => [],
      getById: async () => undefined,
    }));

    assert.deepEqual(plugin.metadata.capabilities, [
      PluginCapability.AsyncKnowledgeStoreProvider,
    ]);
  });

  test('the contributed store is harvested and functional', async () => {
    const store = await makeStore();
    const loader = new PluginLoader(new PluginRegistry());

    await loader.install(createAsyncKnowledgeStorePlugin(() => store));

    assert.equal(loader.getAsyncKnowledgeStores().length, 1);
    assert.equal(
      loader.getInstallation('core.postgres-knowledge-store').contributions.providesAsyncKnowledgeStore,
      true,
    );

    const [contributed] = loader.getAsyncKnowledgeStores();
    await contributed?.add({ id: 'wired', title: 'Wired', content: 'hello' });

    assert.equal((await store.getById('wired'))?.content, 'hello');
  });

  test('uninstall removes the contributed store', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    await loader.install(createAsyncKnowledgeStorePlugin(() => new PostgresKnowledgeStore(makeFakeClient())));

    await loader.uninstall('core.postgres-knowledge-store');

    assert.deepEqual(loader.getAsyncKnowledgeStores(), []);
  });
});
