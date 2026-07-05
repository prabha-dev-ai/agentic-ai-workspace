import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from './AgentRegistry.ts';
import { AgentStatus } from './AgentStatus.ts';
import { EventBus } from '../events/EventBus.ts';
import { EventType } from '../events/EventType.ts';

function register(registry: AgentRegistry, id: string) {
  return registry.register({ id, name: `Agent ${id}`, type: 'test' });
}

describe('registration', () => {
  test('register returns a handle and a complete descriptor', () => {
    const registry = new AgentRegistry();

    const handle = registry.register({
      name: 'Assistant',
      type: 'conversational',
      metadata: { model: 'test-model' },
    });

    const descriptor = handle.getDescriptor();
    assert.ok(handle.id.length > 0, 'id generated when omitted');
    assert.equal(descriptor.name, 'Assistant');
    assert.equal(descriptor.type, 'conversational');
    assert.equal(descriptor.state, AgentStatus.Active);
    assert.ok(descriptor.createdAt instanceof Date);
    assert.deepEqual(descriptor.metadata, { model: 'test-model' });
  });

  test('explicit ids are honored; duplicates and blanks rejected', () => {
    const registry = new AgentRegistry();
    register(registry, 'agent-1');

    assert.equal(registry.get('agent-1').name, 'Agent agent-1');
    assert.throws(() => register(registry, 'agent-1'), /already registered/);
    assert.throws(
      () => registry.register({ id: ' ', name: 'x', type: 't' }),
      /non-empty id/,
    );
    assert.throws(
      () => registry.register({ name: '', type: 't' }),
      /non-empty name/,
    );
  });

  test('get/exists/unregister behave; handle.unregister works', () => {
    const registry = new AgentRegistry();
    const handle = register(registry, 'agent-1');

    assert.equal(registry.exists('agent-1'), true);
    handle.unregister();
    assert.equal(registry.exists('agent-1'), false);
    assert.throws(() => registry.get('agent-1'), /not registered/);
    assert.throws(() => registry.unregister('agent-1'), /not registered/);
  });

  test('list and listByState', () => {
    const registry = new AgentRegistry();
    register(registry, 'a');
    register(registry, 'b');

    assert.deepEqual(registry.list().map((d) => d.id), ['a', 'b']);
    assert.equal(registry.listByState(AgentStatus.Active).length, 2);
    assert.deepEqual(registry.listByState(AgentStatus.Failed), []);
  });
});

describe('event-driven state', () => {
  function publish(bus: EventBus, type: EventType, agentId: string) {
    bus.publish({ type, source: `agent:${agentId}` });
  }

  test('terminal lifecycle events update the matching agent only', () => {
    const bus = new EventBus();
    const registry = new AgentRegistry(bus);
    register(registry, 'a');
    register(registry, 'b');
    register(registry, 'c');

    publish(bus, EventType.AgentCompleted, 'a');
    publish(bus, EventType.AgentFailed, 'b');
    publish(bus, EventType.AgentCancelled, 'c');

    assert.equal(registry.get('a').state, AgentStatus.Completed);
    assert.equal(registry.get('b').state, AgentStatus.Failed);
    assert.equal(registry.get('c').state, AgentStatus.Cancelled);
  });

  test('a new execution reactivates a completed agent', () => {
    const bus = new EventBus();
    const registry = new AgentRegistry(bus);
    register(registry, 'a');

    publish(bus, EventType.AgentCompleted, 'a');
    assert.equal(registry.get('a').state, AgentStatus.Completed);

    publish(bus, EventType.AgentCreated, 'a');
    assert.equal(registry.get('a').state, AgentStatus.Active, 'next run reactivates');
  });

  test('unknown agents and non-agent sources are ignored', () => {
    const bus = new EventBus();
    const registry = new AgentRegistry(bus);
    register(registry, 'a');

    publish(bus, EventType.AgentFailed, 'ghost');
    bus.publish({ type: EventType.PluginInstalled, source: 'plugin-loader' });

    assert.equal(registry.get('a').state, AgentStatus.Active);
    assert.equal(registry.list().length, 1, 'no phantom registrations');
  });
});

describe('diagnostics', () => {
  test('counts per state and total', () => {
    const bus = new EventBus();
    const registry = new AgentRegistry(bus);
    register(registry, 'a1');
    register(registry, 'a2');
    register(registry, 'c1');
    register(registry, 'f1');
    register(registry, 'x1');

    bus.publish({ type: EventType.AgentCompleted, source: 'agent:c1' });
    bus.publish({ type: EventType.AgentFailed, source: 'agent:f1' });
    bus.publish({ type: EventType.AgentCancelled, source: 'agent:x1' });

    assert.deepEqual(registry.getDiagnostics(), {
      active: 2,
      completed: 1,
      failed: 1,
      cancelled: 1,
      total: 5,
    });
  });
});
