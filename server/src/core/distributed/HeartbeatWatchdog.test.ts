import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../agents/AgentRegistry.ts';
import { EventBus } from '../events/EventBus.ts';
import { EventType } from '../events/EventType.ts';
import { AgentStatus } from '../agents/AgentStatus.ts';
import { InMemoryDistributedTransport, InMemoryTransportHub } from './InMemoryDistributedTransport.ts';
import { WorkerRegistry } from './WorkerRegistry.ts';
import { HeartbeatWatchdog } from './HeartbeatWatchdog.ts';

function makeNode() {
  const hub = new InMemoryTransportHub();
  const eventBus = new EventBus();
  const transport = new InMemoryDistributedTransport(hub);
  const agentRegistry = new AgentRegistry(eventBus);
  const workerRegistry = new WorkerRegistry({ eventBus, transport, nodeId: 'node-a' });
  workerRegistry.connectAgentRegistry(agentRegistry);
  return { eventBus, agentRegistry, workerRegistry };
}

describe('HeartbeatWatchdog', () => {
  test('sweep declares a stale worker lost and publishes WorkerLost + AgentFailed', () => {
    const { eventBus, workerRegistry } = makeNode();
    workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });

    const watchdog = new HeartbeatWatchdog({ workerRegistry, eventBus, timeoutMs: 1000 });

    const workerLost: unknown[] = [];
    const agentFailed: string[] = [];
    eventBus.subscribe(EventType.WorkerLost, (envelope) => {
      workerLost.push(envelope.payload);
    });
    eventBus.subscribe(EventType.AgentFailed, (envelope) => {
      agentFailed.push(envelope.source);
    });

    const past = new Date(Date.now() - 5000);
    workerRegistry.recordHeartbeat('worker-1', past);

    watchdog.sweep(new Date());

    assert.equal(workerLost.length, 1);
    assert.deepEqual(agentFailed, ['agent:worker-1']);
    assert.equal(watchdog.getDiagnostics().timeouts, 1);
  });

  test('marking a worker failed through AgentFailed reaches AgentRegistry via the mirrored descriptor', () => {
    const { eventBus, agentRegistry, workerRegistry } = makeNode();
    workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });

    const watchdog = new HeartbeatWatchdog({ workerRegistry, eventBus, timeoutMs: 1000 });
    workerRegistry.recordHeartbeat('worker-1', new Date(Date.now() - 5000));
    watchdog.sweep(new Date());

    assert.equal(agentRegistry.get('worker-1').state, AgentStatus.Failed);
  });

  test('a fresh worker is never swept', () => {
    const { eventBus, workerRegistry } = makeNode();
    workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });

    const watchdog = new HeartbeatWatchdog({ workerRegistry, eventBus, timeoutMs: 1000 });
    watchdog.sweep(new Date());

    assert.equal(watchdog.getDiagnostics().timeouts, 0);
  });

  test('the same worker is not declared lost twice in a row', () => {
    const { eventBus, workerRegistry } = makeNode();
    workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });
    workerRegistry.recordHeartbeat('worker-1', new Date(Date.now() - 5000));

    const watchdog = new HeartbeatWatchdog({ workerRegistry, eventBus, timeoutMs: 1000 });
    watchdog.sweep(new Date());
    watchdog.sweep(new Date());

    assert.equal(watchdog.getDiagnostics().timeouts, 1);
  });

  test('a worker that resumes heartbeating can be declared lost again later', () => {
    const { eventBus, workerRegistry } = makeNode();
    workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });
    workerRegistry.recordHeartbeat('worker-1', new Date(Date.now() - 5000));

    const watchdog = new HeartbeatWatchdog({ workerRegistry, eventBus, timeoutMs: 1000 });
    watchdog.sweep(new Date());
    assert.equal(watchdog.getDiagnostics().timeouts, 1);

    // Worker recovers.
    workerRegistry.recordHeartbeat('worker-1', new Date());
    watchdog.sweep(new Date());

    // Goes stale again.
    workerRegistry.recordHeartbeat('worker-1', new Date(Date.now() - 5000));
    watchdog.sweep(new Date());

    assert.equal(watchdog.getDiagnostics().timeouts, 2);
  });

  test('start()/stop() run sweeps on an interval without keeping the process alive', () => {
    const { eventBus, workerRegistry } = makeNode();
    const watchdog = new HeartbeatWatchdog({ workerRegistry, eventBus, sweepIntervalMs: 10 });

    watchdog.start();
    watchdog.start(); // idempotent
    watchdog.stop();
    watchdog.stop(); // idempotent

    assert.equal(watchdog.getDiagnostics().sweeps, 0);
  });
});
