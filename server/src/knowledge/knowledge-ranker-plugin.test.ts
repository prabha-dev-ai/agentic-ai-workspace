import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeRankerPlugin } from './knowledge-ranker-plugin.ts';
import { createWeightedRankingStrategy } from './knowledge-ranker.ts';
import { PluginLoader, PluginRegistry, PluginCapability } from '../core/plugins/index.ts';

describe('knowledge ranker plugin registration', () => {
  test('declares the ranking-strategy-provider capability', () => {
    const plugin = createKnowledgeRankerPlugin(() => createWeightedRankingStrategy());

    assert.equal(plugin.metadata.id, 'core.knowledge-ranker');
    assert.deepEqual(plugin.metadata.capabilities, [
      PluginCapability.RankingStrategyProvider,
    ]);
  });

  test('install contributes a strategy named "weighted"', async () => {
    const loader = new PluginLoader(new PluginRegistry());

    await loader.install(
      createKnowledgeRankerPlugin(() => createWeightedRankingStrategy()),
    );

    const strategies = loader.getRankingStrategies();
    assert.deepEqual(strategies.map((s) => s.name), ['weighted']);

    const scored = await strategies[0]?.score('query', [
      { id: 'a', text: 'x', signals: { s: 1 } },
    ]);
    assert.equal(scored?.[0]?.score, 1);
    assert.equal(scored?.[0]?.explanation.strategy, 'weighted');
  });

  test('installation diagnostics record the strategy contribution', async () => {
    const loader = new PluginLoader(new PluginRegistry());

    await loader.install(
      createKnowledgeRankerPlugin(() => createWeightedRankingStrategy()),
    );

    const installation = loader.getInstallation('core.knowledge-ranker');
    assert.deepEqual(installation.contributions.rankingStrategies, ['weighted']);
  });

  test('uninstall removes the contributed strategy', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    await loader.install(
      createKnowledgeRankerPlugin(() => createWeightedRankingStrategy()),
    );

    await loader.uninstall('core.knowledge-ranker');

    assert.deepEqual(loader.getRankingStrategies(), []);
  });

  test('the strategy accessor is only touched at scoring time', async () => {
    // Mirrors bootstrap: at install time the container (and therefore
    // the real strategy) does not exist yet. Install must succeed.
    let available = false;
    const loader = new PluginLoader(new PluginRegistry());

    await loader.install(
      createKnowledgeRankerPlugin(() => {
        if (!available) {
          throw new Error('resolved too early');
        }
        return createWeightedRankingStrategy();
      }),
    );

    const contribution = loader.getRankingStrategies()[0];
    assert.ok(contribution, 'contribution must be harvested at install');

    await assert.rejects(
      async () => contribution.score('query', []),
      /resolved too early/,
    );

    available = true; // "bootstrap completed"
    assert.deepEqual(await contribution.score('query', []), []);
  });

  test('two plugins contributing the same strategy name collide loudly', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    await loader.install(
      createKnowledgeRankerPlugin(() => createWeightedRankingStrategy()),
    );

    const rival = createKnowledgeRankerPlugin(() => createWeightedRankingStrategy());
    (rival.metadata as { id: string }).id = 'core.rival-ranker';

    await assert.rejects(
      () => loader.install(rival),
      /"weighted".*collides/,
    );
  });
});
