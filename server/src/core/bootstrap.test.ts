import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap } from './bootstrap.ts';
import { TOKENS } from './tokens.ts';
import { createAgent } from '../agents/agent.factory.ts';

describe('framework bootstrap', () => {
  test('resolves every registered framework service', () => {
    const container = bootstrap();

    assert.ok(container.get(TOKENS.openaiClient));
    assert.equal(typeof container.get(TOKENS.llmService).generateResponse, 'function');
    assert.equal(typeof container.get(TOKENS.plannerService).createPlan, 'function');
    assert.equal(typeof container.get(TOKENS.executorService).executePlan, 'function');
    assert.equal(typeof container.get(TOKENS.agentRuntimeFactory).createRuntime, 'function');
    assert.equal(typeof container.get(TOKENS.knowledgeStore).add, 'function');
  });

  test('the runtime factory creates working runtimes without exposing the client', () => {
    const factory = bootstrap().get(TOKENS.agentRuntimeFactory);

    const runtime = factory.createRuntime(
      createAgent({ name: 'probe', description: 'test', systemPrompt: 'x' }),
    );

    assert.equal(runtime.agent.name, 'probe');
    assert.equal(typeof runtime.run, 'function');
    assert.deepEqual(runtime.memory.getHistory(), []);
  });

  test('the OpenAI client is a process-wide singleton', () => {
    const container = bootstrap();

    assert.equal(
      container.get(TOKENS.openaiClient),
      container.get(TOKENS.openaiClient),
      'repeated resolution must return the same client',
    );
  });

  test('services are singletons within a container', () => {
    const container = bootstrap();

    assert.equal(container.get(TOKENS.llmService), container.get(TOKENS.llmService));
    assert.equal(container.get(TOKENS.knowledgeStore), container.get(TOKENS.knowledgeStore));
  });

  test('separate bootstraps produce isolated service instances', () => {
    const a = bootstrap();
    const b = bootstrap();

    assert.notEqual(
      a.get(TOKENS.knowledgeStore),
      b.get(TOKENS.knowledgeStore),
      'containers must not share state',
    );
  });
});
