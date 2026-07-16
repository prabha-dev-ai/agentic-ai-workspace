import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../events/EventBus.ts';
import { EventType } from '../events/EventType.ts';
import { InMemoryDistributedTransport, InMemoryTransportHub } from './InMemoryDistributedTransport.ts';
import { DistributedEventBridge } from './DistributedEventBridge.ts';

function makeNode(hub: InMemoryTransportHub, nodeId: string) {
  const eventBus = new EventBus();
  const transport = new InMemoryDistributedTransport(hub);
  const bridge = new DistributedEventBridge({ eventBus, transport, nodeId });
  bridge.start();
  return { eventBus, transport, bridge };
}

describe('DistributedEventBridge', () => {
  test('propagates a locally-published event onto a peer node\'s EventBus', () => {
    const hub = new InMemoryTransportHub();
    const nodeA = makeNode(hub, 'node-a');
    const nodeB = makeNode(hub, 'node-b');

    const seenOnB: string[] = [];
    nodeB.eventBus.subscribe(EventType.AgentFailed, (envelope) => {
      seenOnB.push(envelope.source);
    });

    nodeA.eventBus.publish({ type: EventType.AgentFailed, source: 'agent:worker-1' });

    assert.deepEqual(seenOnB, ['agent:worker-1']);
  });

  test('does not forward an event back to its own node of origin (no infinite echo)', () => {
    const hub = new InMemoryTransportHub();
    const nodeA = makeNode(hub, 'node-a');
    const nodeB = makeNode(hub, 'node-b');

    let outboundOnA = 0;
    nodeA.eventBus.subscribe('*', () => {
      outboundOnA++;
    });

    nodeA.eventBus.publish({ type: EventType.AgentFailed, source: 'agent:worker-1' });

    // Exactly one local delivery of the original publish on node-a — the
    // event propagated to node-b and back would show up as a second
    // delivery on node-a if the loop guard failed.
    assert.equal(outboundOnA, 1);
    assert.equal(nodeA.bridge.getDiagnostics().propagatedIn, 0);
    assert.equal(nodeB.bridge.getDiagnostics().propagatedIn, 1);
  });

  test('a NEW event published while handling a propagated one still propagates onward', () => {
    const hub = new InMemoryTransportHub();
    const nodeA = makeNode(hub, 'node-a');
    const nodeB = makeNode(hub, 'node-b');

    // Simulate a SupervisorAgent-style cascade on node-b: reacting to a
    // propagated AgentFailed by publishing a brand new TaskFailed.
    nodeB.eventBus.subscribe(EventType.AgentFailed, () => {
      nodeB.eventBus.publish({
        type: EventType.TaskFailed,
        source: 'delegation-manager',
        correlationId: 'task-1',
        payload: { taskId: 'task-1' },
      });
    });

    const seenOnA: string[] = [];
    nodeA.eventBus.subscribe(EventType.TaskFailed, (envelope) => {
      seenOnA.push((envelope.payload as { taskId: string }).taskId);
    });

    nodeA.eventBus.publish({ type: EventType.AgentFailed, source: 'agent:worker-1' });

    assert.deepEqual(seenOnA, ['task-1']);
  });

  test('include restricts which event types cross the wire', () => {
    const hub = new InMemoryTransportHub();
    const eventBusA = new EventBus();
    const transportA = new InMemoryDistributedTransport(hub);
    const bridgeA = new DistributedEventBridge({
      eventBus: eventBusA,
      transport: transportA,
      nodeId: 'node-a',
      include: [EventType.AgentFailed],
    });
    bridgeA.start();

    const nodeB = makeNode(hub, 'node-b');
    const seen: string[] = [];
    nodeB.eventBus.subscribe('*', (envelope) => {
      seen.push(envelope.type);
    });

    eventBusA.publish({ type: EventType.AgentFailed, source: 'agent:worker-1' });
    eventBusA.publish({ type: EventType.WorkerHeartbeat, source: 'worker:worker-1' });

    assert.deepEqual(seen, [EventType.AgentFailed]);
  });

  test('stop() halts both outbound and inbound propagation', () => {
    const hub = new InMemoryTransportHub();
    const nodeA = makeNode(hub, 'node-a');
    const nodeB = makeNode(hub, 'node-b');

    nodeA.bridge.stop();
    nodeB.bridge.stop();

    const seenOnB: string[] = [];
    nodeB.eventBus.subscribe('*', (envelope) => {
      seenOnB.push(envelope.type);
    });

    nodeA.eventBus.publish({ type: EventType.AgentFailed, source: 'agent:worker-1' });

    assert.deepEqual(seenOnB, []);
  });

  test('start() is idempotent', () => {
    const hub = new InMemoryTransportHub();
    const nodeA = makeNode(hub, 'node-a');
    assert.doesNotThrow(() => nodeA.bridge.start());
  });
});
