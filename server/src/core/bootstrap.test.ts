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
    assert.equal(typeof container.get(TOKENS.knowledgeStore).add, 'function');
    assert.equal(typeof container.get(TOKENS.pluginLoader).executeTool, 'function');
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
