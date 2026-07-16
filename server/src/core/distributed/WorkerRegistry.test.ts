import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../agents/AgentRegistry.ts';
import { EventBus } from '../events/EventBus.ts';
import { EventType } from '../events/EventType.ts';
import { InMemoryDistributedTransport, InMemoryTransportHub } from './InMemoryDistributedTransport.ts';
import { WorkerRegistry } from './WorkerRegistry.ts';
import { DistributedError } from './DistributedError.ts';

function makeNode(hub: InMemoryTransportHub, nodeId: string) {
  const eventBus = new EventBus();
  const transport = new InMemoryDistributedTransport(hub);
  const agentRegistry = new AgentRegistry(eventBus);
  const workerRegistry = new WorkerRegistry({ eventBus, transport, nodeId });
  workerRegistry.connectAgentRegistry(agentRegistry);
  return { eventBus, transport, agentRegistry, workerRegistry };
}

describe('WorkerRegistry', () => {
  test('registerLocalWorker mirrors the worker into the connected AgentRegistry', () => {
    const hub = new InMemoryTransportHub();
    const { agentRegistry, workerRegistry } = makeNode(hub, 'node-a');

    workerRegistry.registerLocalWorker({
      id: 'worker-1',
      name: 'Worker One',
      capabilities: ['python'],
    });

    assert.equal(agentRegistry.exists('worker-1'), true);
    const descriptor = agentRegistry.get('worker-1');
    assert.equal(descriptor.type, 'worker');
    assert.deepEqual(descriptor.metadata.capabilities, ['python']);
    assert.equal(descriptor.metadata.nodeId, 'node-a');
  });

  test('registering a duplicate id throws a DistributedError', () => {
    const hub = new InMemoryTransportHub();
    const { workerRegistry } = makeNode(hub, 'node-a');

    workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });
    assert.throws(
      () => workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'Dup' }),
      DistributedError,
    );
  });

  test('publishes EventType.WorkerRegistered on local registration', () => {
    const hub = new InMemoryTransportHub();
    const { eventBus, workerRegistry } = makeNode(hub, 'node-a');

    const seen: string[] = [];
    eventBus.subscribe(EventType.WorkerRegistered, (envelope) => {
      seen.push((envelope.payload as { workerId: string }).workerId);
    });

    workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });
    assert.deepEqual(seen, ['worker-1']);
  });

  test('a peer node discovers a remotely-registered worker and mirrors it locally', () => {
    const hub = new InMemoryTransportHub();
    const nodeA = makeNode(hub, 'node-a');
    const nodeB = makeNode(hub, 'node-b');

    nodeA.workerRegistry.registerLocalWorker({
      id: 'worker-1',
      name: 'Worker One',
      capabilities: ['gpu'],
    });

    assert.equal(nodeB.workerRegistry.exists('worker-1'), true);
    assert.equal(nodeB.workerRegistry.locate('worker-1')?.nodeId, 'node-a');
    assert.equal(nodeB.agentRegistry.exists('worker-1'), true);
    assert.equal(nodeB.agentRegistry.get('worker-1').metadata.distributed, true);
  });

  test('a late-joining node discovers already-registered workers via the discover handshake', () => {
    const hub = new InMemoryTransportHub();
    const nodeA = makeNode(hub, 'node-a');

    nodeA.workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'Worker One' });

    // node-b joins AFTER worker-1 was announced — it must still learn
    // about it via the discover/replay handshake, not miss it.
    const nodeB = makeNode(hub, 'node-b');

    assert.equal(nodeB.workerRegistry.exists('worker-1'), true);
    assert.equal(nodeB.workerRegistry.locate('worker-1')?.nodeId, 'node-a');
  });

  test('findByCapability returns workers local and remote that advertise it', () => {
    const hub = new InMemoryTransportHub();
    const nodeA = makeNode(hub, 'node-a');
    const nodeB = makeNode(hub, 'node-b');

    nodeA.workerRegistry.registerLocalWorker({
      id: 'worker-a',
      name: 'A',
      capabilities: ['python', 'gpu'],
    });
    nodeB.workerRegistry.registerLocalWorker({
      id: 'worker-b',
      name: 'B',
      capabilities: ['python'],
    });

    const pythonWorkers = nodeA.workerRegistry.findByCapability('python').map((w) => w.id).sort();
    assert.deepEqual(pythonWorkers, ['worker-a', 'worker-b']);

    const gpuWorkers = nodeB.workerRegistry.findByCapability('gpu').map((w) => w.id);
    assert.deepEqual(gpuWorkers, ['worker-a']);
  });

  test('recordHeartbeat updates lastHeartbeatAt and getStaleWorkers respects the timeout', () => {
    const hub = new InMemoryTransportHub();
    const { workerRegistry } = makeNode(hub, 'node-a');

    workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });

    const past = new Date(Date.now() - 60_000);
    workerRegistry.recordHeartbeat('worker-1', past);

    const stale = workerRegistry.getStaleWorkers(1000);
    assert.deepEqual(stale.map((w) => w.id), ['worker-1']);

    const recent = new Date();
    workerRegistry.recordHeartbeat('worker-1', recent);
    assert.deepEqual(workerRegistry.getStaleWorkers(1000, recent), []);
  });

  test('recordHeartbeat on an unknown id is silently ignored', () => {
    const hub = new InMemoryTransportHub();
    const { workerRegistry } = makeNode(hub, 'node-a');
    assert.doesNotThrow(() => workerRegistry.recordHeartbeat('ghost'));
  });

  test('unregisterWorker removes locally and propagates removal to peers', () => {
    const hub = new InMemoryTransportHub();
    const nodeA = makeNode(hub, 'node-a');
    const nodeB = makeNode(hub, 'node-b');

    nodeA.workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });
    assert.equal(nodeB.workerRegistry.exists('worker-1'), true);

    nodeA.workerRegistry.unregisterWorker('worker-1');

    assert.equal(nodeA.workerRegistry.exists('worker-1'), false);
    assert.equal(nodeA.agentRegistry.exists('worker-1'), false);
    assert.equal(nodeB.workerRegistry.exists('worker-1'), false);
    assert.equal(nodeB.agentRegistry.exists('worker-1'), false);
  });

  test('isLocal distinguishes locally-hosted workers from mirrored remote ones', () => {
    const hub = new InMemoryTransportHub();
    const nodeA = makeNode(hub, 'node-a');
    const nodeB = makeNode(hub, 'node-b');

    nodeA.workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });

    assert.equal(nodeA.workerRegistry.isLocal('worker-1'), true);
    assert.equal(nodeB.workerRegistry.isLocal('worker-1'), false);
  });

  test('getDiagnostics reports totals split local vs. remote and by node', () => {
    const hub = new InMemoryTransportHub();
    const nodeA = makeNode(hub, 'node-a');
    const nodeB = makeNode(hub, 'node-b');

    nodeA.workerRegistry.registerLocalWorker({ id: 'worker-a', name: 'A' });
    nodeB.workerRegistry.registerLocalWorker({ id: 'worker-b', name: 'B' });

    const diagnostics = nodeA.workerRegistry.getDiagnostics();
    assert.equal(diagnostics.total, 2);
    assert.equal(diagnostics.local, 1);
    assert.equal(diagnostics.remote, 1);
    assert.deepEqual(diagnostics.byNode, { 'node-a': 1, 'node-b': 1 });
  });
});
