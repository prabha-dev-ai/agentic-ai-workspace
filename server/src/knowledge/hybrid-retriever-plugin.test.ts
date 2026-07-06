import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHybridRetrieverPlugin } from './hybrid-retriever-plugin.ts';
import { PluginLoader, PluginRegistry, PluginCapability } from '../core/plugins/index.ts';
import type { HybridRetriever, HybridRetrievalResult } from './hybrid-retriever.ts';

function makeFakeRetriever(results: HybridRetrievalResult[]): HybridRetriever {
  return {
    retrieve: async () => results,
    getDiagnostics: () => ({
      totalQueries: 0,
      keywordCandidates: 0,
      vectorCandidates: 0,
      vectorSearchesSkipped: 0,
      failures: 0,
    }),
  };
}

const fakeResults: HybridRetrievalResult[] = [
  {
    id: 'a',
    text: 'first context',
    combinedScore: 1,
    keywordScore: 1,
    vectorScore: 1,
    sources: ['keyword', 'vector'],
  },
  {
    id: 'b',
    text: 'second context',
    combinedScore: 0.5,
    keywordScore: 1,
    vectorScore: 0,
    sources: ['keyword'],
  },
];

describe('hybrid retriever plugin registration', () => {
  test('declares the existing retriever-provider capability', () => {
    const plugin = createHybridRetrieverPlugin(() => makeFakeRetriever([]));

    assert.equal(plugin.metadata.id, 'core.hybrid-retriever');
    assert.deepEqual(plugin.metadata.capabilities, [
      PluginCapability.RetrieverProvider,
    ]);
  });

  test('install contributes a retriever named "hybrid"', async () => {
    const loader = new PluginLoader(new PluginRegistry());

    await loader.install(
      createHybridRetrieverPlugin(() => makeFakeRetriever(fakeResults)),
    );

    const retrievers = loader.getRetrievers();
    assert.deepEqual(retrievers.map((r) => r.name), ['hybrid']);

    // The contribution contract: ranked context STRINGS, best first.
    const contexts = await retrievers[0]?.retrieve('any query');
    assert.deepEqual(contexts, ['first context', 'second context']);
  });

  test('installation diagnostics record the retriever contribution', async () => {
    const loader = new PluginLoader(new PluginRegistry());

    await loader.install(createHybridRetrieverPlugin(() => makeFakeRetriever([])));

    const installation = loader.getInstallation('core.hybrid-retriever');
    assert.deepEqual(installation.contributions.retrievers, ['hybrid']);
  });

  test('uninstall removes the contributed retriever', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    await loader.install(createHybridRetrieverPlugin(() => makeFakeRetriever([])));

    await loader.uninstall('core.hybrid-retriever');

    assert.deepEqual(loader.getRetrievers(), []);
  });

  test('the retriever accessor is only touched at retrieve time', async () => {
    // Mirrors bootstrap: at install time the container (and therefore
    // the real retriever) does not exist yet. Install must succeed.
    let available = false;
    const loader = new PluginLoader(new PluginRegistry());

    await loader.install(
      createHybridRetrieverPlugin(() => {
        if (!available) {
          throw new Error('resolved too early');
        }
        return makeFakeRetriever(fakeResults);
      }),
    );

    const contribution = loader.getRetrievers()[0];
    assert.ok(contribution, 'contribution must be harvested at install');

    await assert.rejects(
      async () => contribution.retrieve('query'),
      /resolved too early/,
    );

    available = true; // "bootstrap completed"
    assert.deepEqual(await contribution.retrieve('query'), [
      'first context',
      'second context',
    ]);
  });
});
