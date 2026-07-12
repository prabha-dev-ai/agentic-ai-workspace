import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckpointError } from './CheckpointError.ts';
import { InMemoryCheckpointStore } from './InMemoryCheckpointStore.ts';
import { CheckpointManager } from './CheckpointManager.ts';
import { createAsyncCheckpointStorePlugin } from './AsyncCheckpointStorePlugin.ts';
import { EventBus } from '../events/EventBus.ts';
import { EventType } from '../events/EventType.ts';
import { PluginLoader, PluginRegistry, PluginCapability } from '../plugins/index.ts';
import type { AgentPlugin, CheckpointStoreProvider, AsyncCheckpointStoreProvider } from '../plugins/index.ts';
import type { CheckpointStore } from './CheckpointStore.ts';
import type { AsyncCheckpointStore } from './AsyncCheckpointStore.ts';
import type { Checkpoint } from './Checkpoint.ts';
import type { CheckpointStoreStats } from './CheckpointStore.ts';

describe('InMemoryCheckpointStore', () => {
  test('save then getLatest returns the saved checkpoint', () => {
    const store = new InMemoryCheckpointStore<string>();
    const checkpoint = store.save('agent-1', 'state-a');

    assert.equal(checkpoint.subjectId, 'agent-1');
    assert.equal(checkpoint.data, 'state-a');
    assert.ok(checkpoint.id);
    assert.ok(checkpoint.createdAt instanceof Date);
    assert.equal(store.getLatest('agent-1'), checkpoint);
  });

  test('getLatest on a subject with no checkpoints returns undefined and counts a miss', () => {
    const store = new InMemoryCheckpointStore();

    assert.equal(store.getLatest('missing'), undefined);
    assert.equal(store.getStats().misses, 1);
    assert.equal(store.getStats().recoveries, 0);
  });

  test('multiple saves accumulate a history; getLatest is the most recent', () => {
    const store = new InMemoryCheckpointStore<string>();
    store.save('agent-1', 'first');
    store.save('agent-1', 'second');
    const third = store.save('agent-1', 'third');

    assert.equal(store.getLatest('agent-1'), third);
    assert.deepEqual(store.list('agent-1').map((c) => c.data), ['first', 'second', 'third']);
  });

  test('checkpoints are isolated per subject', () => {
    const store = new InMemoryCheckpointStore<string>();
    store.save('agent-1', 'a');
    store.save('agent-2', 'b');

    assert.equal(store.list('agent-1').length, 1);
    assert.equal(store.list('agent-2').length, 1);
    assert.equal(store.size, 2);
  });

  test('clear removes only the named subject\'s history', () => {
    const store = new InMemoryCheckpointStore<string>();
    store.save('agent-1', 'a');
    store.save('agent-2', 'b');

    store.clear('agent-1');

    assert.deepEqual(store.list('agent-1'), []);
    assert.equal(store.list('agent-2').length, 1);
    assert.equal(store.size, 1);
  });

  test('metadata is carried on the checkpoint', () => {
    const store = new InMemoryCheckpointStore<string>();
    const checkpoint = store.save('agent-1', 'a', { reason: 'manual' });

    assert.deepEqual(checkpoint.metadata, { reason: 'manual' });
  });

  test('an empty store name is rejected', () => {
    assert.throws(() => new InMemoryCheckpointStore('  '), CheckpointError);
  });

  test('an empty subject id is rejected', () => {
    const store = new InMemoryCheckpointStore();
    assert.throws(() => store.save('  ', 'x'), CheckpointError);
  });

  test('getStats reports saves, recoveries, misses and size together', () => {
    const store = new InMemoryCheckpointStore<string>();
    store.save('agent-1', 'a');
    store.getLatest('agent-1');
    store.getLatest('missing');

    assert.deepEqual(store.getStats(), { saves: 1, recoveries: 1, misses: 1, size: 1 });
  });
});

describe('CheckpointManager: checkpoint/recover', () => {
  test('checkpoint() saves through the active store', () => {
    const manager = new CheckpointManager();
    const checkpoint = manager.checkpoint('agent-1', { step: 3 });

    assert.equal(checkpoint.subjectId, 'agent-1');
    assert.deepEqual(checkpoint.data, { step: 3 });
  });

  test('recover() finds the latest checkpoint for a subject', () => {
    const manager = new CheckpointManager();
    manager.checkpoint('agent-1', { step: 1 });
    manager.checkpoint('agent-1', { step: 2 });

    const result = manager.recover<{ step: number }>('agent-1');

    assert.equal(result.recovered, true);
    assert.ok(result.recovered && result.checkpoint.data.step === 2);
  });

  test('recover() reports failure for an unknown subject, without throwing', () => {
    const manager = new CheckpointManager();

    const result = manager.recover('missing');

    assert.equal(result.recovered, false);
    assert.ok(!result.recovered && result.subjectId === 'missing');
    assert.ok(!result.recovered && /missing/.test(result.reason));
  });

  test('an empty subject id is rejected by checkpoint()', () => {
    const manager = new CheckpointManager();
    assert.throws(() => manager.checkpoint('  ', {}), CheckpointError);
  });
});

describe('CheckpointManager: useStore', () => {
  test('defaults to an in-memory store', () => {
    const manager = new CheckpointManager();
    assert.equal(manager.getStore().name, 'in-memory');
  });

  test('a constructor-supplied store is used from the start', () => {
    const store = new InMemoryCheckpointStore('custom');
    const manager = new CheckpointManager({ store });

    assert.equal(manager.getStore(), store);
  });

  test('useStore swaps the active backend; prior checkpoints stay on the old store', () => {
    const manager = new CheckpointManager();
    manager.checkpoint('agent-1', 'on-old-store');

    const replacement = new InMemoryCheckpointStore('replacement');
    manager.useStore(replacement);

    assert.equal(manager.getStore(), replacement);
    assert.equal(manager.recover('agent-1').recovered, false, 'the new store has no history yet');
  });
});

describe('CheckpointManager: event bus bridge', () => {
  test('checkpoint() publishes CheckpointSaved, correlated by subject id', () => {
    const manager = new CheckpointManager();
    const bus = new EventBus();
    manager.connectEventBus(bus);

    const captured: { type: string; correlationId: string }[] = [];
    bus.subscribe('*', (envelope) => {
      captured.push({ type: envelope.type, correlationId: envelope.correlationId });
    });

    manager.checkpoint('agent-1', 'state');

    assert.deepEqual(captured, [{ type: EventType.CheckpointSaved, correlationId: 'agent-1' }]);
  });

  test('a successful recover() publishes CheckpointRecovered', () => {
    const manager = new CheckpointManager();
    const bus = new EventBus();
    manager.connectEventBus(bus);
    manager.checkpoint('agent-1', 'state');

    const captured: string[] = [];
    bus.subscribe('*', (envelope) => {
      captured.push(envelope.type);
    });
    manager.recover('agent-1');

    assert.deepEqual(captured, [EventType.CheckpointRecovered]);
  });

  test('a missed recover() publishes CheckpointRecoveryFailed', () => {
    const manager = new CheckpointManager();
    const bus = new EventBus();
    manager.connectEventBus(bus);

    const captured: string[] = [];
    bus.subscribe('*', (envelope) => {
      captured.push(envelope.type);
    });
    manager.recover('missing');

    assert.deepEqual(captured, [EventType.CheckpointRecoveryFailed]);
  });

  test('without connectEventBus, checkpoint/recover work normally and publish nothing', () => {
    const manager = new CheckpointManager();

    assert.doesNotThrow(() => {
      manager.checkpoint('agent-1', 'state');
      manager.recover('agent-1');
    });
  });
});

describe('CheckpointManager: diagnostics', () => {
  test('reports the active store name and aggregated stats', () => {
    const manager = new CheckpointManager();
    manager.checkpoint('agent-1', 'a');
    manager.recover('agent-1');
    manager.recover('missing');

    assert.deepEqual(manager.getDiagnostics(), {
      storeName: 'in-memory',
      totalCheckpoints: 1,
      saves: 1,
      recoveries: 1,
      recoveryMisses: 1,
    });
  });

  test('an empty manager reports zeroed diagnostics', () => {
    const manager = new CheckpointManager();

    assert.deepEqual(manager.getDiagnostics(), {
      storeName: 'in-memory',
      totalCheckpoints: 0,
      saves: 0,
      recoveries: 0,
      recoveryMisses: 0,
    });
  });
});

describe('checkpoint store plugin capability', () => {
  function makeCheckpointStorePlugin(store: CheckpointStore): AgentPlugin & CheckpointStoreProvider {
    return {
      metadata: {
        id: 'test.checkpoint-store',
        name: 'Checkpoint Store Plugin',
        version: '1.0.0',
        description: 'test',
        author: 'tests',
        capabilities: [PluginCapability.CheckpointStoreProvider],
      },
      register() {},
      getCheckpointStore: () => store,
    };
  }

  test('the contributed store is harvested, recorded and released', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const store = new InMemoryCheckpointStore('plugin-store');

    await loader.install(makeCheckpointStorePlugin(store));

    assert.deepEqual(loader.getCheckpointStores(), [store]);
    assert.equal(
      loader.getInstallation('test.checkpoint-store').contributions.providesCheckpointStore,
      true,
    );

    await loader.uninstall('test.checkpoint-store');
    assert.deepEqual(loader.getCheckpointStores(), []);
  });

  test('a contributed store wired into the manager via useStore is used for checkpoint/recover', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const store = new InMemoryCheckpointStore('plugin-store');
    await loader.install(makeCheckpointStorePlugin(store));

    const manager = new CheckpointManager();
    const [contributed] = loader.getCheckpointStores();
    if (contributed) {
      manager.useStore(contributed);
    }

    manager.checkpoint('agent-1', 'via-plugin-store');

    assert.equal(store.getLatest('agent-1')?.data, 'via-plugin-store');
  });
});

// An async in-memory checkpoint store, used only to test the manager's
// checkpointAsync()/recoverAsync() surface without a real Postgres
// backend — the same role InMemoryCheckpointStore plays for the sync
// tests above.
class FakeAsyncCheckpointStore implements AsyncCheckpointStore<string> {
  readonly name: string;
  private readonly history = new Map<string, Checkpoint<string>[]>();
  private saves = 0;
  private recoveries = 0;
  private misses = 0;
  private nextId = 0;

  constructor(name = 'fake-async') {
    this.name = name;
  }

  async save(subjectId: string, data: string, metadata?: Record<string, unknown>): Promise<Checkpoint<string>> {
    const checkpoint: Checkpoint<string> = {
      id: `ck-${this.nextId++}`,
      subjectId,
      data,
      createdAt: new Date(),
      metadata,
    };
    const list = this.history.get(subjectId) ?? [];
    list.push(checkpoint);
    this.history.set(subjectId, list);
    this.saves++;
    return checkpoint;
  }

  async getLatest(subjectId: string): Promise<Checkpoint<string> | undefined> {
    const latest = this.history.get(subjectId)?.at(-1);
    if (latest) {
      this.recoveries++;
      return latest;
    }
    this.misses++;
    return undefined;
  }

  async list(subjectId: string): Promise<Checkpoint<string>[]> {
    return [...(this.history.get(subjectId) ?? [])];
  }

  async clear(subjectId: string): Promise<void> {
    this.history.delete(subjectId);
  }

  async getStats(): Promise<CheckpointStoreStats> {
    let size = 0;
    for (const list of this.history.values()) size += list.length;
    return { saves: this.saves, recoveries: this.recoveries, misses: this.misses, size };
  }
}

describe('CheckpointManager: useAsyncStore / checkpointAsync / recoverAsync', () => {
  test('checkpointAsync/recoverAsync fail without a configured async store', async () => {
    const manager = new CheckpointManager();

    await assert.rejects(() => manager.checkpointAsync('agent-1', 'x'), CheckpointError);
    await assert.rejects(() => manager.recoverAsync('agent-1'), CheckpointError);
  });

  test('the sync path is untouched by configuring an async store', () => {
    const manager = new CheckpointManager();
    manager.useAsyncStore(new FakeAsyncCheckpointStore());

    const checkpoint = manager.checkpoint('agent-1', { step: 1 });
    assert.equal(checkpoint.subjectId, 'agent-1');
    assert.equal(manager.getStore().name, 'in-memory', 'the sync store is a separate, unaffected backend');
  });

  test('checkpointAsync saves through the async store', async () => {
    const manager = new CheckpointManager();
    manager.useAsyncStore(new FakeAsyncCheckpointStore());

    const checkpoint = await manager.checkpointAsync('agent-1', 'state-a');

    assert.equal(checkpoint.subjectId, 'agent-1');
    assert.equal(checkpoint.data, 'state-a');
  });

  test('recoverAsync finds the latest checkpoint for a subject', async () => {
    const manager = new CheckpointManager();
    manager.useAsyncStore(new FakeAsyncCheckpointStore());

    await manager.checkpointAsync('agent-1', 'first');
    await manager.checkpointAsync('agent-1', 'second');

    const result = await manager.recoverAsync<string>('agent-1');
    assert.equal(result.recovered, true);
    assert.ok(result.recovered && result.checkpoint.data === 'second');
  });

  test('recoverAsync reports failure for an unknown subject, without throwing', async () => {
    const manager = new CheckpointManager();
    manager.useAsyncStore(new FakeAsyncCheckpointStore());

    const result = await manager.recoverAsync('missing');
    assert.equal(result.recovered, false);
  });

  test('getAsyncStore reflects the configured backend', () => {
    const manager = new CheckpointManager();
    assert.equal(manager.getAsyncStore(), undefined);

    const store = new FakeAsyncCheckpointStore();
    manager.useAsyncStore(store);
    assert.equal(manager.getAsyncStore(), store);
  });

  test('checkpointAsync/recoverAsync publish onto the event bus, same as the sync path', async () => {
    const manager = new CheckpointManager();
    manager.useAsyncStore(new FakeAsyncCheckpointStore());
    const bus = new EventBus();
    manager.connectEventBus(bus);

    const captured: string[] = [];
    bus.subscribe('*', (envelope) => {
      captured.push(envelope.type);
    });

    await manager.checkpointAsync('agent-1', 'state');
    await manager.recoverAsync('agent-1');

    assert.deepEqual(captured, [EventType.CheckpointSaved, EventType.CheckpointRecovered]);
  });

  test('getAsyncDiagnostics reports the async store name and stats', async () => {
    const manager = new CheckpointManager();
    manager.useAsyncStore(new FakeAsyncCheckpointStore('postgres'));

    await manager.checkpointAsync('agent-1', 'a');
    await manager.recoverAsync('agent-1');

    const diagnostics = await manager.getAsyncDiagnostics();
    assert.equal(diagnostics.storeName, 'postgres');
    assert.equal(diagnostics.saves, 1);
    assert.equal(diagnostics.recoveries, 1);
  });
});

describe('async checkpoint store plugin capability', () => {
  function makeAsyncCheckpointStorePlugin(
    store: AsyncCheckpointStore,
  ): AgentPlugin & AsyncCheckpointStoreProvider {
    return createAsyncCheckpointStorePlugin(() => store);
  }

  test('declares the async-checkpoint-store-provider capability', () => {
    const plugin = makeAsyncCheckpointStorePlugin(new FakeAsyncCheckpointStore());
    assert.deepEqual(plugin.metadata.capabilities, [
      PluginCapability.AsyncCheckpointStoreProvider,
    ]);
  });

  test('the contributed store is harvested and reachable through the manager', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const store = new FakeAsyncCheckpointStore('plugin-store');
    await loader.install(makeAsyncCheckpointStorePlugin(store));

    assert.equal(loader.getAsyncCheckpointStores().length, 1);
    assert.equal(
      loader.getInstallation('core.postgres-checkpoint-store').contributions.providesAsyncCheckpointStore,
      true,
    );

    const manager = new CheckpointManager();
    const [contributed] = loader.getAsyncCheckpointStores();
    if (contributed) {
      manager.useAsyncStore(contributed);
    }

    await manager.checkpointAsync('agent-1', 'via-plugin-store');
    assert.equal((await store.getLatest('agent-1'))?.data, 'via-plugin-store');
  });

  test('uninstall removes the contributed async store', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    await loader.install(makeAsyncCheckpointStorePlugin(new FakeAsyncCheckpointStore()));

    await loader.uninstall('core.postgres-checkpoint-store');

    assert.deepEqual(loader.getAsyncCheckpointStores(), []);
  });

  test('the store accessor is only touched at call time', async () => {
    let available = false;
    const store = new FakeAsyncCheckpointStore();
    const loader = new PluginLoader(new PluginRegistry());

    await loader.install(
      createAsyncCheckpointStorePlugin(() => {
        if (!available) throw new Error('resolved too early');
        return store;
      }),
    );

    const contribution = loader.getAsyncCheckpointStores()[0];
    assert.ok(contribution);
    await assert.rejects(() => contribution.save('x', 'data'), /resolved too early/);

    available = true;
    await contribution.save('x', 'data');
    assert.equal((await contribution.getLatest('x'))?.data, 'data');
  });
});
