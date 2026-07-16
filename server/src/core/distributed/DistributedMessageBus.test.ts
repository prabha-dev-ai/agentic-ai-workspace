import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../events/EventBus.ts';
import { EventType } from '../events/EventType.ts';
import { InMemoryDistributedTransport, InMemoryTransportHub } from './InMemoryDistributedTransport.ts';
import { WorkerRegistry } from './WorkerRegistry.ts';
import { DistributedMessageBus } from './DistributedMessageBus.ts';
import { RemoteTaskBridge } from './RemoteTaskBridge.ts';

function makeNode(hub: InMemoryTransportHub, nodeId: string) {
  const eventBus = new EventBus();
  const transport = new InMemoryDistributedTransport(hub);
  const messageBus = new DistributedMessageBus(eventBus, transport, nodeId);
  const workerRegistry = new WorkerRegistry({ eventBus, transport, nodeId });
  messageBus.connectWorkerRegistry(workerRegistry);
  return { eventBus, transport, messageBus, workerRegistry };
}

describe('DistributedMessageBus', () => {
  test('behaves exactly like MessageBus for a purely local recipient', () => {
    const hub = new InMemoryTransportHub();
    const { messageBus } = makeNode(hub, 'node-a');

    messageBus.registerMailbox('worker-1');
    messageBus.send({ fromAgentId: 'sender', toAgentId: 'worker-1', messageType: 'greet' });

    assert.equal(messageBus.getMailbox('worker-1').size(), 1);
  });

  test('an unknown recipient still throws the ordinary "no mailbox" error', () => {
    const hub = new InMemoryTransportHub();
    const { messageBus } = makeNode(hub, 'node-a');

    assert.throws(
      () => messageBus.send({ fromAgentId: 'sender', toAgentId: 'ghost', messageType: 'greet' }),
      /no mailbox registered/,
    );
  });

  test('forwards a send() to a worker registered on a different node', () => {
    const hub = new InMemoryTransportHub();
    const nodeA = makeNode(hub, 'node-a');
    const nodeB = makeNode(hub, 'node-b');

    // worker-1 genuinely lives on node-b: it gets a real local mailbox
    // there, the same way any locally-registered agent would.
    nodeB.workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });
    nodeB.messageBus.registerMailbox('worker-1');

    const message = nodeA.messageBus.send({
      fromAgentId: 'coordinator',
      toAgentId: 'worker-1',
      messageType: 'task.assignment',
      payload: { taskId: 'task-1' },
    });

    assert.equal(message.toAgentId, 'worker-1');
    // Never landed in a local (inert) mailbox on node-a...
    assert.equal(nodeA.messageBus.hasMailbox('worker-1'), false);
    // ...it crossed the wire and landed in node-b's real mailbox.
    const envelope = nodeB.messageBus.getMailbox('worker-1').dequeue();
    assert.equal(envelope?.message.messageType, 'task.assignment');
    assert.deepEqual(envelope?.message.payload, { taskId: 'task-1' });
  });

  test('publishes MessageSent and TaskDelegatedRemote on the sending node for a forwarded task assignment', () => {
    const hub = new InMemoryTransportHub();
    const nodeA = makeNode(hub, 'node-a');
    const nodeB = makeNode(hub, 'node-b');
    nodeB.workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });
    nodeB.messageBus.registerMailbox('worker-1');

    const sentTypes: string[] = [];
    nodeA.eventBus.subscribe('*', (envelope) => {
      sentTypes.push(envelope.type);
    });

    nodeA.messageBus.send({
      fromAgentId: 'coordinator',
      toAgentId: 'worker-1',
      messageType: 'task.assignment',
      payload: { taskId: 'task-1' },
    });

    assert.ok(sentTypes.includes(EventType.MessageSent));
    assert.ok(sentTypes.includes(EventType.TaskDelegatedRemote));
  });

  test('connects RemoteTaskBridge origin-tracking when delivering a forwarded task assignment', () => {
    const hub = new InMemoryTransportHub();
    const nodeA = makeNode(hub, 'node-a');
    const nodeB = makeNode(hub, 'node-b');
    nodeB.workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });
    nodeB.messageBus.registerMailbox('worker-1');

    const bridgeB = new RemoteTaskBridge({ transport: nodeB.transport, nodeId: 'node-b' });
    nodeB.messageBus.connectRemoteTaskBridge(bridgeB);

    nodeA.messageBus.send({
      fromAgentId: 'coordinator',
      toAgentId: 'worker-1',
      messageType: 'task.assignment',
      payload: { taskId: 'task-1' },
    });

    assert.equal(bridgeB.getDiagnostics().trackedOrigins, 1);
  });

  test('a delivery failure on the receiving node does not throw back through the sender', () => {
    const hub = new InMemoryTransportHub();
    const nodeA = makeNode(hub, 'node-a');
    const nodeB = makeNode(hub, 'node-b');

    // worker-1 is announced (known to WorkerRegistry) but its mailbox was
    // never actually registered on node-b — an inconsistent-but-possible
    // state (e.g. a crash between the two steps).
    nodeB.workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });

    assert.doesNotThrow(() =>
      nodeA.messageBus.send({
        fromAgentId: 'coordinator',
        toAgentId: 'worker-1',
        messageType: 'task.assignment',
      }),
    );
  });

  test('without a connected WorkerRegistry, send() behaves exactly like plain MessageBus', () => {
    const hub = new InMemoryTransportHub();
    const eventBus = new EventBus();
    const transport = new InMemoryDistributedTransport(hub);
    const messageBus = new DistributedMessageBus(eventBus, transport, 'node-a');

    assert.throws(
      () => messageBus.send({ fromAgentId: 'sender', toAgentId: 'ghost', messageType: 'greet' }),
      /no mailbox registered/,
    );
  });
});
