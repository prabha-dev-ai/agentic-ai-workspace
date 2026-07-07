import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { InteractionError } from './InteractionError.ts';
import { InteractionType } from './InteractionType.ts';
import { InteractionStatus } from './InteractionStatus.ts';
import { InteractionManager } from './InteractionManager.ts';
import { AgentLifecycle } from '../lifecycle/AgentLifecycle.ts';
import { AgentState } from '../lifecycle/AgentState.ts';
import { EventBus } from '../events/EventBus.ts';
import { EventType } from '../events/EventType.ts';
import { PluginLoader, PluginRegistry, PluginCapability } from '../plugins/index.ts';
import type { AgentPlugin, InteractionObserverProvider } from '../plugins/index.ts';
import type { InteractionObserver } from './InteractionManager.ts';

function readyLifecycle(): AgentLifecycle {
  const lifecycle = new AgentLifecycle('lc-1');
  lifecycle.transition(AgentState.Initializing);
  lifecycle.transition(AgentState.Ready);
  lifecycle.transition(AgentState.Executing);
  return lifecycle;
}

describe('Interaction: model', () => {
  test('requestApproval creates a Pending approval interaction', () => {
    const manager = new InteractionManager();
    const interaction = manager.requestApproval('Delete the file?');

    assert.equal(interaction.type, InteractionType.Approval);
    assert.equal(interaction.status, InteractionStatus.Pending);
    assert.equal(interaction.prompt, 'Delete the file?');
    assert.ok(interaction.id);
    assert.ok(interaction.createdAt instanceof Date);
    assert.equal(interaction.resolvedAt, undefined);
    assert.equal(interaction.response, undefined);
  });

  test('requestInput creates a Pending input interaction', () => {
    const manager = new InteractionManager();
    const interaction = manager.requestInput('What is the target directory?');

    assert.equal(interaction.type, InteractionType.Input);
    assert.equal(interaction.status, InteractionStatus.Pending);
  });

  test('metadata and agentId are carried on the interaction', () => {
    const manager = new InteractionManager();
    const interaction = manager.requestApproval('Proceed?', {
      agentId: 'agent-1',
      metadata: { risk: 'high' },
    });

    assert.equal(interaction.agentId, 'agent-1');
    assert.deepEqual(interaction.metadata, { risk: 'high' });
  });

  test('an empty prompt is rejected', () => {
    const manager = new InteractionManager();
    assert.throws(() => manager.requestApproval('  '), InteractionError);
  });
});

describe('Interaction: respond/cancel/timeout', () => {
  test('respond() resolves the interaction and settles wait()', async () => {
    const manager = new InteractionManager();
    const interaction = manager.requestApproval('Proceed?');

    const waiting = interaction.wait();
    interaction.respond({ type: 'approval', approved: true });

    assert.equal(interaction.status, InteractionStatus.Resolved);
    assert.ok(interaction.resolvedAt instanceof Date);
    assert.deepEqual(interaction.response, { type: 'approval', approved: true });

    const resolved = await waiting;
    assert.deepEqual(resolved, { type: 'approval', approved: true });
  });

  test('cancel() resolves wait() with undefined', async () => {
    const manager = new InteractionManager();
    const interaction = manager.requestInput('Value?');

    const waiting = interaction.wait();
    interaction.cancel();

    assert.equal(interaction.status, InteractionStatus.Cancelled);
    assert.equal(await waiting, undefined);
  });

  test('timeout() resolves wait() with undefined', async () => {
    const manager = new InteractionManager();
    const interaction = manager.requestInput('Value?');

    const waiting = interaction.wait();
    interaction.timeout();

    assert.equal(interaction.status, InteractionStatus.TimedOut);
    assert.equal(await waiting, undefined);
  });

  test('respond/cancel/timeout all throw once already resolved', () => {
    const manager = new InteractionManager();
    const interaction = manager.requestApproval('Proceed?');
    interaction.respond({ type: 'approval', approved: true });

    assert.throws(() => interaction.respond({ type: 'approval', approved: false }), InteractionError);
    assert.throws(() => interaction.cancel(), InteractionError);
    assert.throws(() => interaction.timeout(), InteractionError);
  });
});

describe('Interaction: pause/resume via AgentLifecycle', () => {
  test('requesting an interaction with a lifecycle pauses it to WaitingForUser', () => {
    const manager = new InteractionManager();
    const lifecycle = readyLifecycle();

    manager.requestApproval('Proceed?', { lifecycle });

    assert.equal(lifecycle.getState(), AgentState.WaitingForUser);
  });

  test('resolving the interaction resumes the lifecycle to Executing', () => {
    const manager = new InteractionManager();
    const lifecycle = readyLifecycle();
    const interaction = manager.requestApproval('Proceed?', { lifecycle });

    interaction.respond({ type: 'approval', approved: true });

    assert.equal(lifecycle.getState(), AgentState.Executing);
  });

  test('cancelling and timing out also resume the lifecycle', () => {
    const manager = new InteractionManager();

    const lifecycleA = readyLifecycle();
    manager.requestApproval('A?', { lifecycle: lifecycleA }).cancel();
    assert.equal(lifecycleA.getState(), AgentState.Executing);

    const lifecycleB = readyLifecycle();
    manager.requestApproval('B?', { lifecycle: lifecycleB }).timeout();
    assert.equal(lifecycleB.getState(), AgentState.Executing);
  });

  test('a lifecycle not in Executing is left alone — no forced pause', () => {
    const manager = new InteractionManager();
    const lifecycle = new AgentLifecycle('lc-2'); // still Created

    manager.requestApproval('Proceed?', { lifecycle });

    assert.equal(lifecycle.getState(), AgentState.Created);
  });

  test('a lifecycle moved elsewhere before resolution is left alone on resume', () => {
    const manager = new InteractionManager();
    const lifecycle = readyLifecycle();
    const interaction = manager.requestApproval('Proceed?', { lifecycle });

    // Something else already moved it out of WaitingForUser.
    lifecycle.transition(AgentState.Failed, 'unrelated failure');

    interaction.respond({ type: 'approval', approved: true });

    assert.equal(lifecycle.getState(), AgentState.Failed, 'resolve does not force a transition');
  });

  test('without a lifecycle, requesting and resolving an interaction has no side effects to check — just works', () => {
    const manager = new InteractionManager();
    const interaction = manager.requestApproval('Proceed?');

    assert.doesNotThrow(() => interaction.respond({ type: 'approval', approved: true }));
  });
});

describe('InteractionManager: retrieval', () => {
  test('getInteraction finds by id; listInteractions returns oldest first', () => {
    const manager = new InteractionManager();
    const first = manager.requestApproval('A?');
    const second = manager.requestInput('B?');

    assert.equal(manager.getInteraction(first.id), first);
    assert.deepEqual(manager.listInteractions(), [first, second]);
  });

  test('listPending excludes resolved interactions', () => {
    const manager = new InteractionManager();
    const pending = manager.requestApproval('A?');
    const resolved = manager.requestApproval('B?');
    resolved.respond({ type: 'approval', approved: true });

    assert.deepEqual(manager.listPending(), [pending]);
  });

  test('maxInteractions evicts the oldest from lookup without breaking it', () => {
    const manager = new InteractionManager({ maxInteractions: 2 });
    const first = manager.requestApproval('A?');
    manager.requestApproval('B?');
    manager.requestApproval('C?');

    assert.equal(manager.getInteraction(first.id), undefined);
    assert.equal(manager.listInteractions().length, 2);
    assert.doesNotThrow(() => first.respond({ type: 'approval', approved: true }));
  });
});

describe('InteractionManager: observers', () => {
  test('every observer receives every interaction event', () => {
    const manager = new InteractionManager();
    const seen: string[] = [];
    manager.addObserver({ name: 'watcher', onEvent: (event) => seen.push(event.type) });

    manager.requestApproval('A?').respond({ type: 'approval', approved: true });

    assert.deepEqual(seen, ['requested', 'resolved']);
  });

  test('a throwing observer is isolated and counted, others still receive', () => {
    const manager = new InteractionManager();
    const broken: InteractionObserver = {
      name: 'broken',
      onEvent: () => {
        throw new Error('boom');
      },
    };
    const seen: string[] = [];
    manager.addObserver(broken);
    manager.addObserver({ name: 'healthy', onEvent: (event) => seen.push(event.type) });

    manager.requestApproval('A?');

    assert.deepEqual(seen, ['requested']);
    assert.equal(manager.getDiagnostics().observerFailures, 1);
  });

  test('duplicate observer names fail loudly; removeObserver stops delivery', () => {
    const manager = new InteractionManager();
    const seen: string[] = [];
    manager.addObserver({ name: 'watcher', onEvent: (event) => seen.push(event.type) });

    assert.throws(
      () => manager.addObserver({ name: 'watcher', onEvent: () => {} }),
      InteractionError,
    );

    manager.removeObserver('watcher');
    manager.requestApproval('A?');

    assert.deepEqual(seen, []);
    assert.throws(() => manager.removeObserver('watcher'), InteractionError);
  });

  test('an unnamed observer is rejected', () => {
    const manager = new InteractionManager();
    assert.throws(() => manager.addObserver({ name: '', onEvent: () => {} }), InteractionError);
  });
});

describe('InteractionManager: event bus bridge', () => {
  test('requested/resolved publish onto the connected event bus, correlated by interaction id', () => {
    const manager = new InteractionManager();
    const bus = new EventBus();
    manager.connectEventBus(bus);

    const published: string[] = [];
    bus.subscribe('*', (envelope) => {
      published.push(envelope.type);
    });

    const interaction = manager.requestApproval('Proceed?');
    interaction.respond({ type: 'approval', approved: true });

    assert.deepEqual(published, [EventType.InteractionRequested, EventType.InteractionResolved]);
  });

  test('cancelled and timed-out publish their own event types', () => {
    const manager = new InteractionManager();
    const bus = new EventBus();
    manager.connectEventBus(bus);

    const published: string[] = [];
    bus.subscribe('*', (envelope) => {
      published.push(envelope.type);
    });

    manager.requestApproval('A?').cancel();
    manager.requestApproval('B?').timeout();

    assert.deepEqual(published, [
      EventType.InteractionRequested,
      EventType.InteractionCancelled,
      EventType.InteractionRequested,
      EventType.InteractionTimedOut,
    ]);
  });

  test('the envelope correlation id is the interaction id', () => {
    const manager = new InteractionManager();
    const bus = new EventBus();
    manager.connectEventBus(bus);

    const captured: string[] = [];
    bus.subscribe(EventType.InteractionRequested, (envelope) => {
      captured.push(envelope.correlationId);
    });

    const interaction = manager.requestApproval('Proceed?');

    assert.deepEqual(captured, [interaction.id]);
  });

  test('without connectEventBus, interactions work normally and publish nothing', () => {
    const manager = new InteractionManager();
    const interaction = manager.requestApproval('Proceed?');

    assert.doesNotThrow(() => interaction.respond({ type: 'approval', approved: true }));
  });

  test('pausing a lifecycle also emits the framework agent-level event via LifecycleManager wiring', () => {
    const bus = new EventBus();
    const published: string[] = [];
    bus.subscribe('*', (envelope) => {
      published.push(envelope.type);
    });

    const lifecycle = new AgentLifecycle('lc-3', (from, to) => {
      if (to === AgentState.WaitingForUser) {
        bus.publish({ type: EventType.InteractionRequested, source: 'test', correlationId: 'lc-3' });
      }
      if (to === AgentState.Executing && from === AgentState.WaitingForUser) {
        bus.publish({ type: EventType.InteractionResolved, source: 'test', correlationId: 'lc-3' });
      }
    });
    lifecycle.transition(AgentState.Initializing);
    lifecycle.transition(AgentState.Ready);
    lifecycle.transition(AgentState.Executing);

    const manager = new InteractionManager();
    manager.requestApproval('Proceed?', { lifecycle }).respond({ type: 'approval', approved: true });

    assert.deepEqual(published, [EventType.InteractionRequested, EventType.InteractionResolved]);
  });
});

describe('InteractionManager: diagnostics', () => {
  test('counters track totals and the pending/resolved/cancelled/timedout breakdown', () => {
    const manager = new InteractionManager();

    manager.requestApproval('pending');
    manager.requestApproval('resolved').respond({ type: 'approval', approved: true });
    manager.requestApproval('cancelled').cancel();
    manager.requestApproval('timedout').timeout();

    const diagnostics = manager.getDiagnostics();
    assert.equal(diagnostics.totalInteractions, 4);
    assert.equal(diagnostics.pendingInteractions, 1);
    assert.equal(diagnostics.resolvedInteractions, 1);
    assert.equal(diagnostics.cancelledInteractions, 1);
    assert.equal(diagnostics.timedOutInteractions, 1);
  });

  test('an empty manager reports zeroed diagnostics', () => {
    const manager = new InteractionManager();

    assert.deepEqual(manager.getDiagnostics(), {
      totalInteractions: 0,
      pendingInteractions: 0,
      resolvedInteractions: 0,
      cancelledInteractions: 0,
      timedOutInteractions: 0,
      observers: [],
      observerFailures: 0,
    });
  });
});

describe('interaction observer plugin capability', () => {
  function makeObserverPlugin(observer: InteractionObserver): AgentPlugin & InteractionObserverProvider {
    return {
      metadata: {
        id: 'test.interaction-observer',
        name: 'Interaction Observer Plugin',
        version: '1.0.0',
        description: 'test',
        author: 'tests',
        capabilities: [PluginCapability.InteractionObserverProvider],
      },
      register() {},
      getInteractionObservers: () => [observer],
    };
  }

  test('contributed observers are harvested, recorded and released', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const observer: InteractionObserver = { name: 'collector', onEvent: () => {} };

    await loader.install(makeObserverPlugin(observer));

    assert.deepEqual(loader.getInteractionObservers().map((entry) => entry.name), ['collector']);
    assert.deepEqual(
      loader.getInstallation('test.interaction-observer').contributions.interactionObservers,
      ['collector'],
    );

    await loader.uninstall('test.interaction-observer');
    assert.deepEqual(loader.getInteractionObservers(), []);
  });

  test('a contributed observer wired into the manager receives events', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const seen: string[] = [];
    const observer: InteractionObserver = { name: 'collector', onEvent: (event) => seen.push(event.type) };
    await loader.install(makeObserverPlugin(observer));

    const manager = new InteractionManager();
    for (const contributed of loader.getInteractionObservers()) {
      manager.addObserver(contributed);
    }

    manager.requestApproval('Proceed?');

    assert.deepEqual(seen, ['requested']);
  });
});
