import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from './agent.runtime.ts';
import { createAgent } from './agent.factory.ts';
import { AgentState } from '../core/lifecycle/AgentState.ts';
import type OpenAI from 'openai';
import type { ToolSource } from './agent-loop.ts';

// Lifecycle integration: every run() must leave a complete, accurate
// transition record on the runtime's LifecycleManager.

const agent = createAgent({
  name: 'lifecycle-integration',
  description: 'test',
  systemPrompt: 'x',
});

const noTools: ToolSource = {
  getToolDefinitions: () => [],
  executeTool: () => {
    throw new Error('no tools expected');
  },
};

function answeringClient(): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: 'done', tool_calls: undefined } }],
        }),
      },
    },
  } as unknown as OpenAI;
}

describe('runtime lifecycle integration', () => {
  test('a successful run records the full happy path', async () => {
    const runtime = createAgentRuntime(agent, {
      client: answeringClient(),
      tools: noTools,
    });

    await runtime.run('hello');

    const [lifecycle] = runtime.lifecycles.list();
    assert.ok(lifecycle);
    assert.equal(lifecycle.getState(), AgentState.Completed);
    assert.deepEqual(
      lifecycle.getHistory().map((event) => event.to),
      [
        AgentState.Created,
        AgentState.Initializing,
        AgentState.Ready,
        AgentState.Executing,
        AgentState.Completed,
      ],
    );
    assert.ok(lifecycle.getDuration() >= 0);
  });

  test('tool calls appear as WaitingForTool round trips with the tool name', async () => {
    let call = 0;
    const toolCallingClient = {
      chat: {
        completions: {
          create: async () => {
            call++;
            if (call === 1) {
              return {
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [
                        {
                          type: 'function',
                          id: 'call_1',
                          function: { name: 'get_data', arguments: '{}' },
                        },
                      ],
                    },
                  },
                ],
              };
            }
            return {
              choices: [{ message: { content: 'done', tool_calls: undefined } }],
            };
          },
        },
      },
    } as unknown as OpenAI;

    const tools: ToolSource = {
      getToolDefinitions: () => [
        {
          type: 'function',
          function: { name: 'get_data', description: 't', parameters: { type: 'object', properties: {} } },
        },
      ],
      executeTool: () => 'data',
    };

    const runtime = createAgentRuntime(agent, { client: toolCallingClient, tools });
    await runtime.run('use the tool');

    const [lifecycle] = runtime.lifecycles.list();
    const states = lifecycle?.getHistory().map((event) => event.to);
    assert.deepEqual(states, [
      AgentState.Created,
      AgentState.Initializing,
      AgentState.Ready,
      AgentState.Executing,
      AgentState.WaitingForTool,
      AgentState.Executing,
      AgentState.Completed,
    ]);

    const wait = lifecycle
      ?.getHistory()
      .find((event) => event.to === AgentState.WaitingForTool);
    assert.equal(wait?.reason, 'tool: get_data');
  });

  test('a failed run ends in Failed with the error as reason', async () => {
    const failingClient = {
      chat: {
        completions: {
          create: async () => {
            throw new Error('provider down');
          },
        },
      },
    } as unknown as OpenAI;

    const runtime = createAgentRuntime(agent, { client: failingClient, tools: noTools });

    await assert.rejects(() => runtime.run('x'), /provider down/);

    const [lifecycle] = runtime.lifecycles.list();
    assert.equal(lifecycle?.getState(), AgentState.Failed);
    assert.equal(lifecycle?.getHistory().at(-1)?.reason, 'provider down');
    assert.equal(lifecycle?.isTerminal(), true);
  });

  test('runs publish correlated framework events when a bus is provided', async () => {
    const { EventBus } = await import('../core/events/EventBus.ts');
    const { EventType } = await import('../core/events/EventType.ts');

    const bus = new EventBus();
    const seen: { type: string; source: string; correlationId: string }[] = [];
    bus.subscribe('*', (envelope) => {
      seen.push({
        type: envelope.type,
        source: envelope.source,
        correlationId: envelope.correlationId,
      });
    });

    const runtime = createAgentRuntime(agent, {
      client: answeringClient(),
      tools: noTools,
      eventBus: bus,
    });
    await runtime.run('hello');

    assert.deepEqual(
      seen.map((event) => event.type),
      [
        EventType.AgentCreated,
        EventType.AgentInitialized,
        EventType.ExecutionStarted,
        EventType.AgentCompleted,
      ],
    );
    assert.equal(seen[0]?.source, 'agent:lifecycle-integration');

    const [lifecycle] = runtime.lifecycles.list();
    assert.ok(seen.every((event) => event.correlationId === lifecycle?.id));
  });

  test('with a registry, the runtime registers its agent and events drive its state', async () => {
    const { EventBus } = await import('../core/events/EventBus.ts');
    const { AgentRegistry } = await import('../core/agents/AgentRegistry.ts');
    const { AgentStatus } = await import('../core/agents/AgentStatus.ts');

    const bus = new EventBus();
    const registry = new AgentRegistry(bus);

    const runtime = createAgentRuntime(agent, {
      client: answeringClient(),
      tools: noTools,
      eventBus: bus,
      agentRegistry: registry,
    });

    const [descriptor] = registry.list();
    assert.ok(descriptor, 'runtime registered its agent on creation');
    assert.equal(descriptor.name, 'lifecycle-integration');
    assert.equal(descriptor.type, 'conversational');
    assert.equal(descriptor.state, AgentStatus.Active);

    await runtime.run('hello');
    assert.equal(
      registry.get(descriptor.id).state,
      AgentStatus.Completed,
      'state updated via events, not direct calls',
    );

    const failing = createAgentRuntime(agent, {
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('down');
            },
          },
        },
      } as unknown as OpenAI,
      tools: noTools,
      eventBus: bus,
      agentRegistry: registry,
    });

    await assert.rejects(() => failing.run('x'));
    const failedDescriptor = registry
      .list()
      .find((entry) => entry.id !== descriptor.id);
    assert.equal(failedDescriptor?.state, AgentStatus.Failed);
    assert.deepEqual(registry.getDiagnostics(), {
      active: 0,
      completed: 1,
      failed: 1,
      cancelled: 0,
      total: 2,
    });
  });

  test('every run gets its own lifecycle instance', async () => {
    const runtime = createAgentRuntime(agent, {
      client: answeringClient(),
      tools: noTools,
    });

    await runtime.run('one');
    await runtime.run('two');

    const lifecycles = runtime.lifecycles.list();
    assert.equal(lifecycles.length, 2);
    assert.ok(lifecycles.every((l) => l.getState() === AgentState.Completed));
    assert.notEqual(lifecycles[0]?.id, lifecycles[1]?.id);
  });
});
