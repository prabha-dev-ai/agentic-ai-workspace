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
