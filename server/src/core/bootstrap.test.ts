import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap } from './bootstrap.ts';
import { TOKENS } from './tokens.ts';
import { createAgent } from '../agents/agent.factory.ts';

describe('framework bootstrap', () => {
  test('resolves every registered framework service', async () => {
    const container = await bootstrap();

    assert.ok(container.get(TOKENS.openaiClient));
    assert.equal(typeof container.get(TOKENS.llmService).generateResponse, 'function');
    assert.equal(typeof container.get(TOKENS.plannerService).createPlan, 'function');
    assert.equal(typeof container.get(TOKENS.executorService).executePlan, 'function');
    assert.equal(typeof container.get(TOKENS.agentRuntimeFactory).createRuntime, 'function');
    assert.equal(typeof container.get(TOKENS.agentLifecycle).spawn, 'function');
    assert.equal(typeof container.get(TOKENS.eventBus).publish, 'function');
    assert.equal(typeof container.get(TOKENS.agentRegistry).register, 'function');
    assert.equal(typeof container.get(TOKENS.messageBus).send, 'function');
    assert.equal(typeof container.get(TOKENS.delegationManager).createTask, 'function');
    assert.equal(typeof container.get(TOKENS.supervisorAgent).submitWork, 'function');
    assert.equal(typeof container.get(TOKENS.knowledgeStore).add, 'function');
    assert.equal(typeof container.get(TOKENS.pluginLoader).executeTool, 'function');
    assert.equal(typeof container.get(TOKENS.embeddingProvider).embed, 'function');
    assert.equal(typeof container.get(TOKENS.embeddingService).embedBatch, 'function');
    assert.equal(typeof container.get(TOKENS.vectorStore).search, 'function');
    assert.equal(typeof container.get(TOKENS.hybridRetriever).retrieve, 'function');
    assert.equal(typeof container.get(TOKENS.rankingStrategy).score, 'function');
    assert.equal(typeof container.get(TOKENS.knowledgeRanker).rank, 'function');
    assert.equal(typeof container.get(TOKENS.observability).getLogger, 'function');
    assert.equal(typeof container.get(TOKENS.tracing).getTracer, 'function');
    assert.equal(typeof container.get(TOKENS.metrics).counter, 'function');
    assert.equal(typeof container.get(TOKENS.caching).getOrCreate, 'function');
    assert.equal(typeof container.get(TOKENS.security).getSecret, 'function');
    assert.equal(typeof container.get(TOKENS.streaming).createStream, 'function');
  });

  test('observability is live from the first plugin install', async () => {
    const container = await bootstrap();
    const observability = container.get(TOKENS.observability);

    const diagnostics = observability.getDiagnostics();
    assert.ok(diagnostics.sinks.includes('console'), 'console sink registered');
    assert.ok(
      diagnostics.totalEntries >= 5,
      'each built-in plugin logged "installed" through its context',
    );
    assert.ok(
      diagnostics.suppressedEntries >= 5,
      'event traffic is counted (suppressed below the info threshold)',
    );
  });

  test('tracing is live from the first plugin install', async () => {
    const container = await bootstrap();
    const tracing = container.get(TOKENS.tracing);

    const diagnostics = tracing.getDiagnostics();
    assert.ok(diagnostics.exporters.includes('console'), 'console exporter registered');
    assert.ok(
      diagnostics.totalSpans >= 1,
      'each built-in plugin install is bridged onto the trace stream',
    );
  });

  test('metrics is live from the first plugin install', async () => {
    const container = await bootstrap();
    const metrics = container.get(TOKENS.metrics);

    const diagnostics = metrics.getDiagnostics();
    assert.ok(diagnostics.exporters.includes('console'), 'console exporter registered');

    metrics.counter('probe_total').inc();
    const snapshot = metrics.export();
    assert.ok(snapshot.some((metric) => metric.name === 'probe_total'));
    assert.equal(metrics.getDiagnostics().exportCount, 1);
  });

  test('caching is live from bootstrap', async () => {
    const container = await bootstrap();
    const caching = container.get(TOKENS.caching);

    const cache = caching.getOrCreate<string>('probe');
    cache.set('k', 'v');

    assert.equal(cache.get('k'), 'v');
    assert.equal(caching.getDiagnostics().totalEntries, 1);
  });

  test('security is live from bootstrap', async () => {
    const container = await bootstrap();
    const security = container.get(TOKENS.security);

    const diagnostics = security.getDiagnostics();
    assert.ok(diagnostics.secretSources.includes('api-keys'), 'API key provider registered');

    security.validateInput('a normal prompt');
    assert.equal(security.getDiagnostics().validationsPassed, 1);
  });

  test('streaming is live from bootstrap and bridges lifecycle milestones onto the event bus', async () => {
    const container = await bootstrap();
    const streaming = container.get(TOKENS.streaming);
    const bus = container.get(TOKENS.eventBus);

    const publishedBefore = bus.getDiagnostics().publishedEvents;

    const stream = streaming.createStream<string>('probe');
    stream.push('chunk');
    stream.complete();

    assert.equal(stream.chunkCount, 1);
    assert.equal(streaming.getDiagnostics().totalStreams, 1);
    assert.ok(
      bus.getDiagnostics().publishedEvents > publishedBefore,
      'stream lifecycle milestones were published',
    );
  });

  test('the default ranking strategy is installed as a built-in plugin', async () => {
    const container = await bootstrap();

    const registry = container.get(TOKENS.pluginRegistry);
    assert.equal(registry.exists('core.knowledge-ranker'), true);

    const loader = container.get(TOKENS.pluginLoader);
    const names = loader.getRankingStrategies().map((strategy) => strategy.name);
    assert.deepEqual(names, ['weighted']);
  });

  test('hybrid retrieval is installed as a built-in retriever plugin', async () => {
    const container = await bootstrap();

    const registry = container.get(TOKENS.pluginRegistry);
    assert.equal(registry.exists('core.hybrid-retriever'), true);

    const loader = container.get(TOKENS.pluginLoader);
    const names = loader.getRetrievers().map((retriever) => retriever.name);
    assert.ok(names.includes('hybrid'), 'hybrid retriever must be contributed');
  });

  test('the default vector store is installed as a built-in plugin', async () => {
    const container = await bootstrap();

    const registry = container.get(TOKENS.pluginRegistry);
    assert.equal(registry.exists('core.vectorstore'), true);

    const loader = container.get(TOKENS.pluginLoader);
    const contributions = loader.getVectorStores();
    assert.equal(contributions.length, 1);

    // The plugin contribution and the DI registration are the same
    // store — a document added through one is visible through the other.
    await contributions[0]?.add({ id: 'wired', text: 'hello', vector: [1, 0] });
    const store = container.get(TOKENS.vectorStore);
    assert.equal((await store.get('wired'))?.text, 'hello');
  });

  test('the default embedding provider is installed as a built-in plugin', async () => {
    const container = await bootstrap();

    const registry = container.get(TOKENS.pluginRegistry);
    assert.equal(registry.exists('core.embeddings'), true);

    const loader = container.get(TOKENS.pluginLoader);
    const contributions = loader.getEmbeddingProviders();
    assert.equal(contributions.length, 1);

    // The plugin contribution and the DI registration are the same
    // provider — one client, one model, two ways to discover it.
    assert.equal(
      contributions[0]?.model.name,
      container.get(TOKENS.embeddingProvider).model.name,
    );
  });

  test('installs built-in plugins and exposes their tools', async () => {
    const container = await bootstrap();

    const registry = container.get(TOKENS.pluginRegistry);
    assert.equal(registry.exists('core.time'), true, 'core.time must be installed');

    const loader = container.get(TOKENS.pluginLoader);
    const names = loader
      .getToolDefinitions()
      .map((def) => (def.type === 'function' ? def.function.name : '?'));
    assert.ok(names.includes('get_current_time'), 'time tool must be contributed');

    const result = await loader.executeTool('get_current_time');
    assert.match(result, /\d{4}/, 'executing the time tool returns a real date');
  });

  test('a custom plugin directory replaces the built-in set', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = mkdtempSync(join(tmpdir(), 'bootstrap-plugins-'));
    try {
      writeFileSync(
        join(dir, 'custom.plugin.ts'),
        `export const customPlugin = {
          metadata: {
            id: 'test.custom', name: 'Custom', version: '1.0.0',
            description: 'fixture', author: 'tests', capabilities: [],
          },
          register() {},
        };\n`,
      );

      const container = await bootstrap({ pluginDirectory: dir });
      const registry = container.get(TOKENS.pluginRegistry);

      assert.equal(registry.exists('test.custom'), true);
      assert.equal(registry.exists('core.time'), false, 'default dir not scanned');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('built-in plugin installs are published on the event bus', async () => {
    const container = await bootstrap();
    const bus = container.get(TOKENS.eventBus);

    const diagnostics = bus.getDiagnostics();
    assert.ok(
      diagnostics.publishedEvents >= 1,
      'core.time install must have been published',
    );
  });

  test('agents registered through the container registry get mailboxes', async () => {
    const container = await bootstrap();
    const registry = container.get(TOKENS.agentRegistry);
    const messageBus = container.get(TOKENS.messageBus);

    registry.register({ id: 'wired', name: 'Wired', type: 'test' });

    assert.equal(messageBus.hasMailbox('wired'), true);
  });

  test('installation diagnostics are available through the container', async () => {
    const loader = (await bootstrap()).get(TOKENS.pluginLoader);

    const installations = loader.listInstallations();
    assert.equal(installations.length, 5, 'built-in plugins installed');

    const time = installations.find((entry) => entry.pluginId === 'core.time');
    assert.deepEqual(time?.contributions.tools, ['get_current_time']);
    assert.equal(time?.contributions.providesServices, false);

    const embeddings = installations.find(
      (entry) => entry.pluginId === 'core.embeddings',
    );
    assert.equal(embeddings?.contributions.providesEmbeddings, true);

    const vectorStore = installations.find(
      (entry) => entry.pluginId === 'core.vectorstore',
    );
    assert.equal(vectorStore?.contributions.providesVectorStore, true);

    const hybrid = installations.find(
      (entry) => entry.pluginId === 'core.hybrid-retriever',
    );
    assert.deepEqual(hybrid?.contributions.retrievers, ['hybrid']);

    const ranker = installations.find(
      (entry) => entry.pluginId === 'core.knowledge-ranker',
    );
    assert.deepEqual(ranker?.contributions.rankingStrategies, ['weighted']);
  });

  test('the OpenAI client is a process-wide singleton', async () => {
    const container = await bootstrap();

    assert.equal(
      container.get(TOKENS.openaiClient),
      container.get(TOKENS.openaiClient),
      'repeated resolution must return the same client',
    );
  });

  test('services are singletons within a container', async () => {
    const container = await bootstrap();

    assert.equal(container.get(TOKENS.llmService), container.get(TOKENS.llmService));
    assert.equal(container.get(TOKENS.knowledgeStore), container.get(TOKENS.knowledgeStore));
  });

  test('separate bootstraps produce isolated service instances', async () => {
    const a = await bootstrap();
    const b = await bootstrap();

    assert.notEqual(
      a.get(TOKENS.knowledgeStore),
      b.get(TOKENS.knowledgeStore),
      'containers must not share state',
    );
  });

  test('the runtime factory creates working runtimes without exposing the client', async () => {
    const factory = (await bootstrap()).get(TOKENS.agentRuntimeFactory);

    const runtime = factory.createRuntime(
      createAgent({ name: 'probe', description: 'test', systemPrompt: 'x' }),
    );

    assert.equal(runtime.agent.name, 'probe');
    assert.equal(typeof runtime.run, 'function');
    assert.deepEqual(runtime.memory.getHistory(), []);
  });
});
