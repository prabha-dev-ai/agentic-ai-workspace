import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../events/EventBus.ts';
import { EventType } from '../events/EventType.ts';
import { InMemoryDistributedTransport, InMemoryTransportHub } from './InMemoryDistributedTransport.ts';
import { WorkerRegistry } from './WorkerRegistry.ts';
import { WorkerHeartbeatSender } from './WorkerHeartbeatSender.ts';

describe('WorkerHeartbeatSender', () => {
  test('beat() refreshes lastHeartbeatAt for every locally-hosted worker', () => {
    const hub = new InMemoryTransportHub();
    const eventBus = new EventBus();
    const transport = new InMemoryDistributedTransport(hub);
    const workerRegistry = new WorkerRegistry({ eventBus, transport, nodeId: 'node-a' });

    workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });
    const past = new Date(Date.now() - 60_000);
    workerRegistry.recordHeartbeat('worker-1', past);

    const sender = new WorkerHeartbeatSender({ workerRegistry, transport, eventBus, nodeId: 'node-a' });
    sender.beat();

    assert.notEqual(workerRegistry.get('worker-1').lastHeartbeatAt.getTime(), past.getTime());
  });

  test('beat() publishes EventType.WorkerHeartbeat locally', () => {
    const hub = new InMemoryTransportHub();
    const eventBus = new EventBus();
    const transport = new InMemoryDistributedTransport(hub);
    const workerRegistry = new WorkerRegistry({ eventBus, transport, nodeId: 'node-a' });
    workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });

    const seen: string[] = [];
    eventBus.subscribe(EventType.WorkerHeartbeat, (envelope) => {
      seen.push((envelope.payload as { workerId: string }).workerId);
    });

    new WorkerHeartbeatSender({ workerRegistry, transport, eventBus, nodeId: 'node-a' }).beat();

    assert.deepEqual(seen, ['worker-1']);
  });

  test("beat() keeps a peer node's mirrored copy of the worker fresh", () => {
    const hub = new InMemoryTransportHub();

    const nodeA = {
      eventBus: new EventBus(),
      transport: new InMemoryDistributedTransport(hub),
    };
    const workerRegistryA = new WorkerRegistry({ ...nodeA, nodeId: 'node-a' });
    workerRegistryA.registerLocalWorker({ id: 'worker-1', name: 'One' });

    const nodeB = {
      eventBus: new EventBus(),
      transport: new InMemoryDistributedTransport(hub),
    };
    const workerRegistryB = new WorkerRegistry({ ...nodeB, nodeId: 'node-b' });

    // node-b learns about worker-1 synchronously, via the discover/replay
    // handshake fired from its own constructor.
    assert.equal(workerRegistryB.exists('worker-1'), true);
    const stalePastOnB = new Date(Date.now() - 60_000);
    workerRegistryB.recordHeartbeat('worker-1', stalePastOnB);

    const sender = new WorkerHeartbeatSender({
      workerRegistry: workerRegistryA,
      transport: nodeA.transport,
      eventBus: nodeA.eventBus,
      nodeId: 'node-a',
    });
    sender.beat();

    assert.ok(
      workerRegistryB.get('worker-1').lastHeartbeatAt.getTime() > stalePastOnB.getTime(),
      'node-b should have received the heartbeat over the transport',
    );
  });

  test('start()/stop() run on an interval without keeping the process alive', () => {
    const hub = new InMemoryTransportHub();
    const eventBus = new EventBus();
    const transport = new InMemoryDistributedTransport(hub);
    const workerRegistry = new WorkerRegistry({ eventBus, transport, nodeId: 'node-a' });
    const sender = new WorkerHeartbeatSender({
      workerRegistry,
      transport,
      eventBus,
      nodeId: 'node-a',
      intervalMs: 10,
    });

    sender.start();
    sender.start(); // idempotent
    sender.stop();
    sender.stop(); // idempotent
  });
});
