import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowError } from './WorkflowError.ts';
import { WorkflowStatus } from './WorkflowStatus.ts';
import { WorkflowRuntime } from './WorkflowRuntime.ts';
import { EventBus } from '../events/EventBus.ts';
import { EventType } from '../events/EventType.ts';
import { PluginLoader, PluginRegistry, PluginCapability } from '../plugins/index.ts';
import type { AgentPlugin, WorkflowDefinitionProvider } from '../plugins/index.ts';
import type { WorkflowObserver } from './WorkflowRuntime.ts';
import type { WorkflowDefinition } from './WorkflowDefinition.ts';
import type { WorkflowStep } from './WorkflowStep.ts';

function step(id: string, execute: WorkflowStep['execute'], next?: WorkflowStep['next']): WorkflowStep {
  return { id, name: id, execute, ...(next !== undefined && { next }) };
}

describe('WorkflowRuntime: definitions', () => {
  test('defineWorkflow registers a definition, retrievable by id', () => {
    const runtime = new WorkflowRuntime();
    const definition: WorkflowDefinition = {
      id: 'greet',
      name: 'Greet',
      description: 'Say hello',
      steps: [step('say-hello', () => 'hello')],
    };

    runtime.defineWorkflow(definition);

    assert.equal(runtime.getDefinition('greet'), definition);
    assert.deepEqual(runtime.listDefinitions(), [definition]);
  });

  test('an empty id is rejected', () => {
    const runtime = new WorkflowRuntime();
    assert.throws(
      () => runtime.defineWorkflow({ id: '', name: 'x', description: 'x', steps: [step('a', () => 1)] }),
      WorkflowError,
    );
  });

  test('a definition with zero steps is rejected', () => {
    const runtime = new WorkflowRuntime();
    assert.throws(
      () => runtime.defineWorkflow({ id: 'empty', name: 'x', description: 'x', steps: [] }),
      WorkflowError,
    );
  });

  test('duplicate step ids within one definition are rejected', () => {
    const runtime = new WorkflowRuntime();
    assert.throws(
      () =>
        runtime.defineWorkflow({
          id: 'dup',
          name: 'x',
          description: 'x',
          steps: [step('a', () => 1), step('a', () => 2)],
        }),
      WorkflowError,
    );
  });

  test('duplicate definition ids are rejected', () => {
    const runtime = new WorkflowRuntime();
    const definition: WorkflowDefinition = { id: 'greet', name: 'x', description: 'x', steps: [step('a', () => 1)] };
    runtime.defineWorkflow(definition);

    assert.throws(() => runtime.defineWorkflow(definition), WorkflowError);
  });
});

describe('WorkflowRuntime: sequential execution', () => {
  test('steps run in array order, each seeing prior results', async () => {
    const runtime = new WorkflowRuntime();
    const order: string[] = [];

    runtime.defineWorkflow({
      id: 'pipeline',
      name: 'Pipeline',
      description: 'x',
      steps: [
        step('a', () => {
          order.push('a');
          return 1;
        }),
        step('b', (ctx) => {
          order.push('b');
          return (ctx.results.a as number) + 1;
        }),
        step('c', (ctx) => {
          order.push('c');
          return (ctx.results.b as number) + 1;
        }),
      ],
    });

    const run = await runtime.run('pipeline');

    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.equal(run.status, WorkflowStatus.Completed);
    assert.deepEqual(run.results, { a: 1, b: 2, c: 3 });
    assert.equal(run.steps.length, 3);
    assert.ok(run.steps.every((s) => s.status === 'completed'));
  });

  test('input is visible to every step', async () => {
    const runtime = new WorkflowRuntime();
    runtime.defineWorkflow({
      id: 'echo',
      name: 'Echo',
      description: 'x',
      steps: [step('read', (ctx) => ctx.input.message)],
    });

    const run = await runtime.run('echo', { message: 'hi' });

    assert.equal(run.results.read, 'hi');
    assert.deepEqual(run.input, { message: 'hi' });
  });

  test('async steps are awaited in order', async () => {
    const runtime = new WorkflowRuntime();
    const order: string[] = [];
    runtime.defineWorkflow({
      id: 'async',
      name: 'Async',
      description: 'x',
      steps: [
        step('a', async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push('a');
          return 'a';
        }),
        step('b', () => {
          order.push('b');
          return 'b';
        }),
      ],
    });

    await runtime.run('async');

    assert.deepEqual(order, ['a', 'b']);
  });
});

describe('WorkflowRuntime: conditional branching', () => {
  test('next() redirects execution to a non-adjacent step', async () => {
    const runtime = new WorkflowRuntime();
    runtime.defineWorkflow({
      id: 'branch',
      name: 'Branch',
      description: 'x',
      steps: [
        step('check', (ctx) => ctx.input.approved === true, (_ctx, output) => (output ? 'approve' : 'reject')),
        // Both branches are terminal — without their own next(), they'd
        // fall through to whatever array entry follows them.
        step('approve', () => 'approved', () => undefined),
        step('reject', () => 'rejected', () => undefined),
      ],
    });

    const approved = await runtime.run('branch', { approved: true });
    assert.deepEqual(approved.steps.map((s) => s.stepId), ['check', 'approve']);
    assert.equal(approved.results.approve, 'approved');

    const rejected = await runtime.run('branch', { approved: false });
    assert.deepEqual(rejected.steps.map((s) => s.stepId), ['check', 'reject']);
    assert.equal(rejected.results.reject, 'rejected');
  });

  test('next() returning undefined ends the workflow early', async () => {
    const runtime = new WorkflowRuntime();
    runtime.defineWorkflow({
      id: 'early-exit',
      name: 'Early Exit',
      description: 'x',
      steps: [
        step('a', () => 'a', () => undefined),
        step('b', () => 'b'),
      ],
    });

    const run = await runtime.run('early-exit');

    assert.deepEqual(run.steps.map((s) => s.stepId), ['a']);
    assert.equal(run.status, WorkflowStatus.Completed);
    assert.equal(run.results.b, undefined);
  });

  test('next() returning an unknown step id fails the run', async () => {
    const runtime = new WorkflowRuntime();
    runtime.defineWorkflow({
      id: 'bad-branch',
      name: 'Bad Branch',
      description: 'x',
      steps: [step('a', () => 'a', () => 'nowhere')],
    });

    const run = await runtime.run('bad-branch');

    assert.equal(run.status, WorkflowStatus.Failed);
    assert.match(run.error ?? '', /nowhere/);
  });
});

describe('WorkflowRuntime: step failure', () => {
  test('a throwing step fails the run without rejecting run()', async () => {
    const runtime = new WorkflowRuntime();
    runtime.defineWorkflow({
      id: 'boom',
      name: 'Boom',
      description: 'x',
      steps: [
        step('a', () => 'ok'),
        step('b', () => {
          throw new Error('step blew up');
        }),
        step('c', () => 'never reached'),
      ],
    });

    const run = await runtime.run('boom');

    assert.equal(run.status, WorkflowStatus.Failed);
    assert.equal(run.error, 'step blew up');
    assert.deepEqual(run.steps.map((s) => s.stepId), ['a', 'b']);
    assert.equal(run.steps[1]?.status, 'failed');
    assert.equal(run.results.c, undefined);
  });

  test('running an unregistered definition throws synchronously', async () => {
    const runtime = new WorkflowRuntime();
    await assert.rejects(() => runtime.run('missing'), WorkflowError);
  });
});

describe('WorkflowRuntime: retrieval', () => {
  test('getRun/listRuns track executed runs, oldest first', async () => {
    const runtime = new WorkflowRuntime();
    runtime.defineWorkflow({ id: 'x', name: 'x', description: 'x', steps: [step('a', () => 1)] });

    const first = await runtime.run('x');
    const second = await runtime.run('x');

    assert.equal(runtime.getRun(first.id), first);
    assert.deepEqual(runtime.listRuns(), [first, second]);
  });

  test('maxRuns evicts the oldest run from lookup', async () => {
    const runtime = new WorkflowRuntime({ maxRuns: 1 });
    runtime.defineWorkflow({ id: 'x', name: 'x', description: 'x', steps: [step('a', () => 1)] });

    const first = await runtime.run('x');
    await runtime.run('x');

    assert.equal(runtime.getRun(first.id), undefined);
    assert.equal(runtime.listRuns().length, 1);
  });
});

describe('WorkflowRuntime: observers', () => {
  test('every observer receives every milestone across a run', async () => {
    const runtime = new WorkflowRuntime();
    runtime.defineWorkflow({
      id: 'x',
      name: 'x',
      description: 'x',
      steps: [step('a', () => 1), step('b', () => 2)],
    });

    const seen: string[] = [];
    runtime.addObserver({ name: 'watcher', onEvent: (event) => seen.push(event.type) });

    await runtime.run('x');

    assert.deepEqual(seen, [
      'started',
      'step-started',
      'step-completed',
      'step-started',
      'step-completed',
      'completed',
    ]);
  });

  test('a throwing observer is isolated and counted, others still receive', async () => {
    const runtime = new WorkflowRuntime();
    runtime.defineWorkflow({ id: 'x', name: 'x', description: 'x', steps: [step('a', () => 1)] });

    const broken: WorkflowObserver = {
      name: 'broken',
      onEvent: () => {
        throw new Error('boom');
      },
    };
    const seen: string[] = [];
    runtime.addObserver(broken);
    runtime.addObserver({ name: 'healthy', onEvent: (event) => seen.push(event.type) });

    await runtime.run('x');

    assert.deepEqual(seen, ['started', 'step-started', 'step-completed', 'completed']);
    assert.equal(runtime.getDiagnostics().observerFailures, 4);
  });

  test('duplicate observer names fail loudly; removeObserver stops delivery', () => {
    const runtime = new WorkflowRuntime();
    runtime.addObserver({ name: 'watcher', onEvent: () => {} });

    assert.throws(() => runtime.addObserver({ name: 'watcher', onEvent: () => {} }), WorkflowError);

    runtime.removeObserver('watcher');
    assert.throws(() => runtime.removeObserver('watcher'), WorkflowError);
  });
});

describe('WorkflowRuntime: event bus bridge', () => {
  test('every milestone including per-step events publishes onto the connected event bus', async () => {
    const runtime = new WorkflowRuntime();
    const bus = new EventBus();
    runtime.connectEventBus(bus);
    runtime.defineWorkflow({
      id: 'x',
      name: 'x',
      description: 'x',
      steps: [step('a', () => 1)],
    });

    const published: string[] = [];
    bus.subscribe('*', (envelope) => {
      published.push(envelope.type);
    });

    await runtime.run('x');

    assert.deepEqual(published, [
      EventType.WorkflowStarted,
      EventType.WorkflowStepStarted,
      EventType.WorkflowStepCompleted,
      EventType.WorkflowCompleted,
    ]);
  });

  test('a failed run publishes WorkflowStepFailed and WorkflowFailed, correlated by run id', async () => {
    const runtime = new WorkflowRuntime();
    const bus = new EventBus();
    runtime.connectEventBus(bus);
    runtime.defineWorkflow({
      id: 'x',
      name: 'x',
      description: 'x',
      steps: [
        step('a', () => {
          throw new Error('boom');
        }),
      ],
    });

    const captured: { type: string; correlationId: string }[] = [];
    bus.subscribe('*', (envelope) => {
      captured.push({ type: envelope.type, correlationId: envelope.correlationId });
    });

    const run = await runtime.run('x');

    assert.deepEqual(
      captured.map((c) => c.type),
      [EventType.WorkflowStarted, EventType.WorkflowStepStarted, EventType.WorkflowStepFailed, EventType.WorkflowFailed],
    );
    assert.ok(captured.every((c) => c.correlationId === run.id));
  });

  test('without connectEventBus, runs work normally and publish nothing', async () => {
    const runtime = new WorkflowRuntime();
    runtime.defineWorkflow({ id: 'x', name: 'x', description: 'x', steps: [step('a', () => 1)] });

    await assert.doesNotReject(() => runtime.run('x'));
  });
});

describe('WorkflowRuntime: diagnostics', () => {
  test('counters track definitions, total/completed/failed runs', async () => {
    const runtime = new WorkflowRuntime();
    runtime.defineWorkflow({ id: 'ok', name: 'x', description: 'x', steps: [step('a', () => 1)] });
    runtime.defineWorkflow({
      id: 'bad',
      name: 'x',
      description: 'x',
      steps: [
        step('a', () => {
          throw new Error('boom');
        }),
      ],
    });

    await runtime.run('ok');
    await runtime.run('bad');

    const diagnostics = runtime.getDiagnostics();
    assert.equal(diagnostics.definitionsRegistered, 2);
    assert.equal(diagnostics.totalRuns, 2);
    assert.equal(diagnostics.completedRuns, 1);
    assert.equal(diagnostics.failedRuns, 1);
  });

  test('an empty runtime reports zeroed diagnostics', () => {
    const runtime = new WorkflowRuntime();

    assert.deepEqual(runtime.getDiagnostics(), {
      definitionsRegistered: 0,
      totalRuns: 0,
      completedRuns: 0,
      failedRuns: 0,
      observers: [],
      observerFailures: 0,
    });
  });
});

describe('workflow definition plugin capability', () => {
  function makeWorkflowPlugin(definition: WorkflowDefinition): AgentPlugin & WorkflowDefinitionProvider {
    return {
      metadata: {
        id: 'test.workflow',
        name: 'Workflow Plugin',
        version: '1.0.0',
        description: 'test',
        author: 'tests',
        capabilities: [PluginCapability.WorkflowDefinitionProvider],
      },
      register() {},
      getWorkflowDefinitions: () => [definition],
    };
  }

  test('contributed definitions are harvested, recorded and released', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const definition: WorkflowDefinition = {
      id: 'plugin-workflow',
      name: 'Plugin Workflow',
      description: 'x',
      steps: [step('a', () => 1)],
    };

    await loader.install(makeWorkflowPlugin(definition));

    assert.deepEqual(loader.getWorkflowDefinitions().map((entry) => entry.id), ['plugin-workflow']);
    assert.deepEqual(
      loader.getInstallation('test.workflow').contributions.workflowDefinitions,
      ['plugin-workflow'],
    );

    await loader.uninstall('test.workflow');
    assert.deepEqual(loader.getWorkflowDefinitions(), []);
  });

  test('a contributed definition wired into the runtime is runnable', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const definition: WorkflowDefinition = {
      id: 'plugin-workflow',
      name: 'Plugin Workflow',
      description: 'x',
      steps: [step('a', () => 'done')],
    };
    await loader.install(makeWorkflowPlugin(definition));

    const runtime = new WorkflowRuntime();
    for (const contributed of loader.getWorkflowDefinitions()) {
      runtime.defineWorkflow(contributed);
    }

    const run = await runtime.run('plugin-workflow');

    assert.equal(run.status, WorkflowStatus.Completed);
    assert.equal(run.results.a, 'done');
  });
});
