import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentLifecycleManager } from './agent-lifecycle.ts';
import { createAgentRuntimeFactory } from './agent.runtime.ts';
import { createAgent } from './agent.factory.ts';
import type OpenAI from 'openai';
import type { ToolSource } from './agent-loop.ts';

const noTools: ToolSource = {
  getToolDefinitions: () => [],
  executeTool: () => {
    throw new Error('no tools in this test');
  },
};

// A fake client whose completion can be resolved on command — lets tests
// hold a session in "busy" deliberately.
function makeGatedClient() {
  let release = () => {};
  const client = {
    chat: {
      completions: {
        create: () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                choices: [{ message: { content: 'answer', tool_calls: undefined } }],
              });
          }),
      },
    },
  };
  return { client: client as unknown as OpenAI, release: () => release() };
}

function makeInstantClient(): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: 'answer', tool_calls: undefined } }],
        }),
      },
    },
  } as unknown as OpenAI;
}

const testAgent = createAgent({
  name: 'lifecycle-tester',
  description: 'test agent',
  systemPrompt: 'x',
});

function makeManager(client: OpenAI) {
  return createAgentLifecycleManager(createAgentRuntimeFactory(client, noTools));
}

describe('session lifecycle', () => {
  test('spawn creates tracked idle sessions with unique ids', () => {
    const manager = makeManager(makeInstantClient());

    const a = manager.spawn(testAgent);
    const b = manager.spawn(testAgent);

    assert.notEqual(a.id, b.id);
    assert.equal(a.status, 'idle');
    assert.equal(a.runCount, 0);
    assert.equal(a.lastActiveAt, null);
    assert.equal(manager.list().length, 2);
    assert.equal(manager.get(a.id), a);
  });

  test('run returns the answer and updates session accounting', async () => {
    const manager = makeManager(makeInstantClient());
    const session = manager.spawn(testAgent);

    const answer = await manager.run(session.id, 'hello');

    assert.equal(answer, 'answer');
    assert.equal(session.status, 'idle');
    assert.equal(session.runCount, 1);
    assert.ok(session.lastActiveAt instanceof Date);
  });

  test('unknown session ids throw', async () => {
    const manager = makeManager(makeInstantClient());

    assert.throws(() => manager.get('nope'), /Unknown agent session "nope"/);
    await assert.rejects(() => manager.run('nope', 'x'), /Unknown agent session/);
  });
});

describe('state machine invariants', () => {
  test('a busy session rejects concurrent runs', async () => {
    const { client, release } = makeGatedClient();
    const manager = makeManager(client);
    const session = manager.spawn(testAgent);

    const firstRun = manager.run(session.id, 'first');
    assert.equal(session.status, 'busy');

    await assert.rejects(
      () => manager.run(session.id, 'second'),
      /already processing a message/,
    );

    release();
    assert.equal(await firstRun, 'answer');
    assert.equal(session.status, 'idle');
    assert.equal(session.runCount, 1, 'rejected run must not count');
  });

  test('a failed run returns the session to idle and is not counted', async () => {
    const failingClient = {
      chat: {
        completions: {
          create: async () => {
            throw new Error('provider down');
          },
        },
      },
    } as unknown as OpenAI;
    const manager = makeManager(failingClient);
    const session = manager.spawn(testAgent);

    await assert.rejects(() => manager.run(session.id, 'x'), /provider down/);
    assert.equal(session.status, 'idle');
    assert.equal(session.runCount, 0);
    assert.ok(session.lastActiveAt instanceof Date, 'activity still recorded');
  });

  test('termination mid-run is never resurrected to idle', async () => {
    const { client, release } = makeGatedClient();
    const manager = makeManager(client);
    const session = manager.spawn(testAgent);

    const running = manager.run(session.id, 'x');
    manager.terminate(session.id);
    release();
    await running;

    assert.equal(session.status, 'terminated', 'finally must not undo termination');
  });
});

describe('termination', () => {
  test('terminate clears memory, blocks runs, and keeps the audit record', async () => {
    const manager = makeManager(makeInstantClient());
    const session = manager.spawn(testAgent);
    await manager.run(session.id, 'remember this');

    manager.terminate(session.id);

    assert.equal(session.status, 'terminated');
    assert.equal(manager.list().length, 1, 'record remains for audit');
    await assert.rejects(() => manager.run(session.id, 'x'), /is terminated/);
  });

  test('terminateAll ends every non-terminated session', async () => {
    const manager = makeManager(makeInstantClient());
    const a = manager.spawn(testAgent);
    const b = manager.spawn(testAgent);
    manager.terminate(a.id);

    manager.terminateAll();

    assert.equal(a.status, 'terminated');
    assert.equal(b.status, 'terminated');
  });
});
