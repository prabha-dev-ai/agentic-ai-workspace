import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbeddingsPlugin } from './EmbeddingsPlugin.ts';
import { PluginLoader, PluginRegistry, PluginCapability } from '../plugins/index.ts';
import type { EmbeddingProvider } from './EmbeddingProvider.ts';

const fakeProvider: EmbeddingProvider = {
  model: { name: 'fake-model', dimensions: 2 },
  async embed() {
    return [1, 2];
  },
  async embedBatch(texts) {
    return texts.map(() => [1, 2]);
  },
};

describe('embeddings plugin registration', () => {
  test('declares the embedding-provider capability', () => {
    const plugin = createEmbeddingsPlugin(() => fakeProvider);

    assert.equal(plugin.metadata.id, 'core.embeddings');
    assert.deepEqual(plugin.metadata.capabilities, [
      PluginCapability.EmbeddingProvider,
    ]);
  });

  test('install contributes the provider to the loader', async () => {
    const loader = new PluginLoader(new PluginRegistry());

    await loader.install(createEmbeddingsPlugin(() => fakeProvider));

    const providers = loader.getEmbeddingProviders();
    assert.equal(providers.length, 1);
    assert.equal(providers[0]?.model.name, 'fake-model');
    assert.deepEqual(await providers[0]?.embed('hi'), [1, 2]);
  });

  test('installation diagnostics record the embedding contribution', async () => {
    const loader = new PluginLoader(new PluginRegistry());

    await loader.install(createEmbeddingsPlugin(() => fakeProvider));

    const installation = loader.getInstallation('core.embeddings');
    assert.equal(installation.contributions.providesEmbeddings, true);
  });

  test('uninstall removes the contributed provider', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    await loader.install(createEmbeddingsPlugin(() => fakeProvider));

    await loader.uninstall('core.embeddings');

    assert.deepEqual(loader.getEmbeddingProviders(), []);
  });

  test('the provider accessor is only touched at embed time', async () => {
    // Mirrors bootstrap: at install time the container (and therefore the
    // real provider) does not exist yet. Install must succeed anyway.
    let available = false;
    const loader = new PluginLoader(new PluginRegistry());

    await loader.install(
      createEmbeddingsPlugin(() => {
        if (!available) {
          throw new Error('resolved too early');
        }
        return fakeProvider;
      }),
    );

    const contribution = loader.getEmbeddingProviders()[0];
    assert.ok(contribution, 'contribution must be harvested at install');

    await assert.rejects(() => contribution.embed('hi'), /resolved too early/);

    available = true; // "bootstrap completed"
    assert.deepEqual(await contribution.embed('hi'), [1, 2]);
    assert.equal(contribution.model.name, 'fake-model');
  });
});
