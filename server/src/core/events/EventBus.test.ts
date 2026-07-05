import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { EventBus } from './EventBus.ts';
import { EventType } from './EventType.ts';
import type { EventEnvelope } from './EventEnvelope.ts';

describe('event envelopes', () => {
  test('publish stamps id, timestamp, and defaults', () => {
    const bus = new EventBus();

    const envelope = bus.publish({
      type: EventType.AgentCreated,
      source: 'test',
      payload: { hello: true },
    });

    assert.ok(envelope.eventId.length > 0);
    assert.ok(envelope.timestamp instanceof Date);
    assert.equal(envelope.source, 'test');
    assert.equal(envelope.correlationId, envelope.eventId, 'self-correlated by default');
    assert.deepEqual(envelope.payload, { hello: true });

    const second = bus.publish({ type: EventType.AgentCreated, source: 'test' });
    assert.notEqual(second.eventId, envelope.eventId, 'ids unique');
    assert.equal(second.payload, null, 'missing payload becomes null');
  });

  test('explicit correlation ids are preserved', () => {
    const bus = new EventBus();

    const envelope = bus.publish({
      type: EventType.AgentCompleted,
      source: 'test',
      correlationId: 'run-42',
    });

    assert.equal(envelope.correlationId, 'run-42');
  });
});

describe('delivery', () => {
  test('exact-type subscribers receive only their type, in order, synchronously', () => {
    const bus = new EventBus();
    const seen: string[] = [];

    bus.subscribe(EventType.AgentCreated, () => {
      seen.push('first');
    });
    bus.subscribe(EventType.AgentCreated, () => {
      seen.push('second');
    });
    bus.subscribe(EventType.AgentCompleted, () => {
      seen.push('wrong-type');
    });

    bus.publish({ type: EventType.AgentCreated, source: 'test' });

    assert.deepEqual(seen, ['first', 'second'], 'ordered, synchronous, filtered');
  });

  test('wildcard subscribers receive everything, after exact-type handlers', () => {
    const bus = new EventBus();
    const seen: string[] = [];

    bus.subscribe('*', () => {
      seen.push('wildcard');
    });
    bus.subscribe(EventType.AgentCreated, () => {
      seen.push('exact');
    });

    bus.publish({ type: EventType.AgentCreated, source: 'test' });
    bus.publish({ type: EventType.PluginInstalled, source: 'test' });

    assert.deepEqual(seen, ['exact', 'wildcard', 'wildcard']);
  });

  test('unsubscribe stops delivery', () => {
    const bus = new EventBus();
    let calls = 0;
    const handler = () => {
      calls++;
    };

    bus.subscribe(EventType.AgentCreated, handler);
    bus.publish({ type: EventType.AgentCreated, source: 'test' });
    bus.unsubscribe(EventType.AgentCreated, handler);
    bus.publish({ type: EventType.AgentCreated, source: 'test' });

    assert.equal(calls, 1);
  });
});

describe('handler isolation and diagnostics', () => {
  test('a throwing handler is recorded and the rest still run', () => {
    const bus = new EventBus();
    const seen: string[] = [];

    bus.subscribe(EventType.AgentCreated, () => {
      throw new Error('subscriber exploded');
    });
    bus.subscribe(EventType.AgentCreated, () => {
      seen.push('survivor');
    });

    const envelope = bus.publish({ type: EventType.AgentCreated, source: 'test' });

    assert.deepEqual(seen, ['survivor']);

    const diagnostics = bus.getDiagnostics();
    assert.equal(diagnostics.handlerFailures.length, 1);
    assert.equal(diagnostics.handlerFailures[0]?.error, 'subscriber exploded');
    assert.equal(diagnostics.handlerFailures[0]?.eventId, envelope.eventId);
  });

  test('async handler rejections are recorded too', async () => {
    const bus = new EventBus();

    bus.subscribe(EventType.AgentCreated, async () => {
      throw new Error('async explosion');
    });

    bus.publish({ type: EventType.AgentCreated, source: 'test' });
    await setImmediate();

    assert.equal(bus.getDiagnostics().handlerFailures[0]?.error, 'async explosion');
  });

  test('diagnostics report published and subscriber counts', () => {
    const bus = new EventBus();
    bus.subscribe(EventType.AgentCreated, () => {});
    bus.subscribe(EventType.AgentCreated, () => {});
    bus.subscribe('*', () => {});

    bus.publish({ type: EventType.AgentCreated, source: 'test' });
    bus.publish({ type: EventType.AgentCompleted, source: 'test' });

    const diagnostics = bus.getDiagnostics();
    assert.equal(diagnostics.publishedEvents, 2);
    assert.deepEqual(diagnostics.subscribers, {
      [EventType.AgentCreated]: 2,
      '*': 1,
    });
    assert.deepEqual(diagnostics.handlerFailures, []);
  });
});

describe('lifecycle event integration', () => {
  test('a tool-using execution publishes the full correlated event story', async () => {
    const { LifecycleManager } = await import('../lifecycle/LifecycleManager.ts');
    const { AgentState } = await import('../lifecycle/AgentState.ts');

    const bus = new EventBus();
    const story: { type: string; correlationId: string }[] = [];
    bus.subscribe('*', (envelope: EventEnvelope) => {
      story.push({ type: envelope.type, correlationId: envelope.correlationId });
    });

    const manager = new LifecycleManager({ eventBus: bus, source: 'agent:test' });
    const lifecycle = manager.create();
    lifecycle.transition(AgentState.Initializing);
    lifecycle.transition(AgentState.Ready);
    lifecycle.transition(AgentState.Executing);
    lifecycle.transition(AgentState.WaitingForTool, 'tool: get_data');
    lifecycle.transition(AgentState.Executing);
    lifecycle.transition(AgentState.Completed);

    assert.deepEqual(
      story.map((event) => event.type),
      [
        EventType.AgentCreated,
        EventType.AgentInitialized,
        EventType.ExecutionStarted,
        EventType.ToolExecutionStarted,
        EventType.ToolExecutionCompleted,
        EventType.AgentCompleted,
      ],
    );
    assert.ok(
      story.every((event) => event.correlationId === lifecycle.id),
      'every event correlated by lifecycle id',
    );
  });

  test('a failure during a tool wait publishes ToolExecutionFailed then AgentFailed', async () => {
    const { LifecycleManager } = await import('../lifecycle/LifecycleManager.ts');
    const { AgentState } = await import('../lifecycle/AgentState.ts');

    const bus = new EventBus();
    const types: string[] = [];
    bus.subscribe('*', (envelope: EventEnvelope) => {
      types.push(envelope.type);
    });

    const manager = new LifecycleManager({ eventBus: bus, source: 'agent:test' });
    const lifecycle = manager.create();
    lifecycle.transition(AgentState.Initializing);
    lifecycle.transition(AgentState.Ready);
    lifecycle.transition(AgentState.Executing);
    lifecycle.transition(AgentState.WaitingForTool);
    lifecycle.transition(AgentState.Failed, 'tool exploded');

    assert.deepEqual(types.slice(-2), [
      EventType.ToolExecutionFailed,
      EventType.AgentFailed,
    ]);
  });
});
