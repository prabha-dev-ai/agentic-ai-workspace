import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createVectorStorePlugin } from './VectorStorePlugin.ts';
import { InMemoryVectorStore } from './InMemoryVectorStore.ts';
import { PluginLoader, PluginRegistry, PluginCapability } from '../plugins/index.ts';

describe('vector store plugin registration', () => {
  test('declares the vector-store-provider capability', () => {
    const plugin = createVectorStorePlugin(() => new InMemoryVectorStore());

    assert.equal(plugin.metadata.id, 'core.vectorstore');
    assert.deepEqual(plugin.metadata.capabilities, [
      PluginCapability.VectorStoreProvider,
    ]);
  });

  test('install contributes the store to the loader', async () => {
    const store = new InMemoryVectorStore();
    const loader = new PluginLoader(new PluginRegistry());

    await loader.install(createVectorStorePlugin(() => store));

    const stores = loader.getVectorStores();
    assert.equal(stores.length, 1);

    // The contribution and the backing store are the same instance:
    // data written through one is visible through the other.
    await stores[0]?.add({ id: 'doc', text: 'hello', vector: [1, 0] });
    assert.equal((await store.get('doc'))?.text, 'hello');
  });

  test('installation diagnostics record the vector store contribution', async () => {
    const loader = new PluginLoader(new PluginRegistry());

    await loader.install(createVectorStorePlugin(() => new InMemoryVectorStore()));

    const installation = loader.getInstallation('core.vectorstore');
    assert.equal(installation.contributions.providesVectorStore, true);
  });

  test('uninstall removes the contributed store', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    await loader.install(createVectorStorePlugin(() => new InMemoryVectorStore()));

    await loader.uninstall('core.vectorstore');

    assert.deepEqual(loader.getVectorStores(), []);
  });

  test('the store accessor is only touched at call time', async () => {
    // Mirrors bootstrap: at install time the container (and therefore the
    // real store) does not exist yet. Install must succeed anyway.
    let available = false;
    const store = new InMemoryVectorStore();
    const loader = new PluginLoader(new PluginRegistry());

    await loader.install(
      createVectorStorePlugin(() => {
        if (!available) {
          throw new Error('resolved too early');
        }
        return store;
      }),
    );

    const contribution = loader.getVectorStores()[0];
    assert.ok(contribution, 'contribution must be harvested at install');

    await assert.rejects(
      () => contribution.add({ id: 'x', text: 'x', vector: [1] }),
      /resolved too early/,
    );

    available = true; // "bootstrap completed"
    await contribution.add({ id: 'x', text: 'x', vector: [1] });
    assert.equal((await contribution.get('x'))?.id, 'x');
  });
});
