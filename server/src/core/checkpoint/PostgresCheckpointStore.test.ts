import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckpointError } from './CheckpointError.ts';
import { PostgresCheckpointStore } from './PostgresCheckpointStore.ts';
import type { PgClient, PgQueryResult } from '../database/PgClient.ts';

// A minimal in-memory stand-in for `pg.Pool`, same idiom as
// PostgresVectorStore.test.ts's fake client — enough SQL surface to
// exercise the store's append-only save/getLatest/list/clear logic
// without a real database.
function makeFakeClient(): PgClient {
  const rows: { id: string; subject_id: string; data: unknown; created_at: Date; metadata: unknown }[] = [];

  return {
    async query<Row>(text: string, params: unknown[] = []): Promise<PgQueryResult<Row>> {
      const sql = text.trim();

      if (sql.startsWith('CREATE TABLE') || sql.startsWith('CREATE INDEX')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.startsWith('INSERT INTO')) {
        const [id, subjectId, data, createdAt, metadata] = params as [string, string, string, Date, string | null];
        rows.push({
          id,
          subject_id: subjectId,
          data: JSON.parse(data),
          created_at: createdAt,
          metadata: metadata ? JSON.parse(metadata) : null,
        });
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('ORDER BY created_at DESC')) {
        const [subjectId] = params as [string];
        const matches = rows
          .filter((row) => row.subject_id === subjectId)
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        return { rows: matches.slice(0, 1) as Row[], rowCount: matches.length > 0 ? 1 : 0 };
      }

      if (sql.includes('ORDER BY created_at ASC')) {
        const [subjectId] = params as [string];
        const matches = rows
          .filter((row) => row.subject_id === subjectId)
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
        return { rows: matches as Row[], rowCount: matches.length };
      }

      if (sql.startsWith('DELETE FROM')) {
        const [subjectId] = params as [string];
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]?.subject_id === subjectId) rows.splice(i, 1);
        }
        return { rows: [], rowCount: before - rows.length };
      }

      if (sql.startsWith('SELECT COUNT')) {
        return { rows: [{ count: String(rows.length) }] as Row[], rowCount: 1 };
      }

      throw new Error(`Unhandled fake query: ${sql}`);
    },
  };
}

async function makeStore(): Promise<PostgresCheckpointStore<string>> {
  const store = new PostgresCheckpointStore<string>(makeFakeClient(), 'postgres-test');
  await store.connect();
  return store;
}

describe('PostgresCheckpointStore: validation', () => {
  test('an empty store name is rejected', () => {
    assert.throws(() => new PostgresCheckpointStore(makeFakeClient(), '  '), CheckpointError);
  });

  test('using the store before connect() rejects', async () => {
    const store = new PostgresCheckpointStore(makeFakeClient(), 'x');
    await assert.rejects(() => store.save('agent-1', 'x'), CheckpointError);
  });

  test('an empty subject id is rejected', async () => {
    const store = await makeStore();
    await assert.rejects(() => store.save('  ', 'x'), CheckpointError);
  });
});

describe('PostgresCheckpointStore: save/getLatest', () => {
  test('save then getLatest returns the saved checkpoint', async () => {
    const store = await makeStore();
    const checkpoint = await store.save('agent-1', 'state-a');

    assert.equal(checkpoint.subjectId, 'agent-1');
    assert.equal(checkpoint.data, 'state-a');
    assert.ok(checkpoint.id);

    const latest = await store.getLatest('agent-1');
    assert.equal(latest?.data, 'state-a');
  });

  test('getLatest on a subject with no checkpoints returns undefined and counts a miss', async () => {
    const store = await makeStore();

    assert.equal(await store.getLatest('missing'), undefined);
    assert.equal((await store.getStats()).misses, 1);
  });

  test('multiple saves accumulate a history; getLatest is the most recent', async () => {
    const store = await makeStore();
    await store.save('agent-1', 'first');
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.save('agent-1', 'second');
    await new Promise((resolve) => setTimeout(resolve, 2));
    const third = await store.save('agent-1', 'third');

    const latest = await store.getLatest('agent-1');
    assert.equal(latest?.id, third.id);

    const history = await store.list('agent-1');
    assert.deepEqual(history.map((c) => c.data), ['first', 'second', 'third']);
  });

  test('checkpoints are isolated per subject', async () => {
    const store = await makeStore();
    await store.save('agent-1', 'a');
    await store.save('agent-2', 'b');

    assert.equal((await store.list('agent-1')).length, 1);
    assert.equal((await store.list('agent-2')).length, 1);
  });

  test('metadata is carried on the checkpoint', async () => {
    const store = await makeStore();
    const checkpoint = await store.save('agent-1', 'a', { reason: 'manual' });

    assert.deepEqual(checkpoint.metadata, { reason: 'manual' });
  });
});

describe('PostgresCheckpointStore: clear', () => {
  test('clear removes only the named subject\'s history', async () => {
    const store = await makeStore();
    await store.save('agent-1', 'a');
    await store.save('agent-2', 'b');

    await store.clear('agent-1');

    assert.deepEqual(await store.list('agent-1'), []);
    assert.equal((await store.list('agent-2')).length, 1);
  });
});

describe('PostgresCheckpointStore: diagnostics', () => {
  test('getStats reports saves, recoveries, misses and a live size', async () => {
    const store = await makeStore();
    await store.save('agent-1', 'a');
    await store.getLatest('agent-1');
    await store.getLatest('missing');

    assert.deepEqual(await store.getStats(), { saves: 1, recoveries: 1, misses: 1, size: 1 });
  });

  test('size is queried live and reflects rows written by a different store instance sharing the client', async () => {
    const client = makeFakeClient();
    const first = new PostgresCheckpointStore(client, 'a');
    await first.connect();
    await first.save('agent-1', 'x');

    const second = new PostgresCheckpointStore(client, 'b');
    await second.connect();

    assert.equal((await second.getStats()).size, 1);
  });
});
