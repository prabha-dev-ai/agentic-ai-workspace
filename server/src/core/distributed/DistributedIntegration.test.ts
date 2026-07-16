import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../agents/AgentRegistry.ts';
import { DelegationManager } from '../delegation/DelegationManager.ts';
import { TaskStatus } from '../delegation/TaskStatus.ts';
import { EventBus } from '../events/EventBus.ts';
import { EventType } from '../events/EventType.ts';
import { InMemoryDistributedTransport, InMemoryTransportHub } from './InMemoryDistributedTransport.ts';
import { WorkerRegistry } from './WorkerRegistry.ts';
import { HeartbeatWatchdog } from './HeartbeatWatchdog.ts';
import { WorkerHeartbeatSender } from './WorkerHeartbeatSender.ts';
import { DistributedMessageBus } from './DistributedMessageBus.ts';
import { RemoteTaskBridge } from './RemoteTaskBridge.ts';
import { DistributedEventBridge } from './DistributedEventBridge.ts';
import { DistributedSupervisor } from './DistributedSupervisor.ts';
import type { TaskAssignment } from '../delegation/TaskAssignment.ts';

// End-to-end: two fully-wired "nodes" sharing one transport hub — the
// same object graph core/bootstrap.ts assembles per process, built by
// hand here so the test controls both sides. Proves the whole AAI-039
// story works together: registration, capability discovery, remote
// delegation, remote execution reporting back, heartbeats, failover, and
// event propagation — not just each piece in isolation.
function makeCoordinatorNode(hub: InMemoryTransportHub, nodeId: string) {
  const eventBus = new EventBus();
  const transport = new InMemoryDistributedTransport(hub);
  const messageBus = new DistributedMessageBus(eventBus, transport, nodeId);
  const agentRegistry = new AgentRegistry(eventBus, messageBus);
  const workerRegistry = new WorkerRegistry({ eventBus, transport, nodeId });
  messageBus.connectWorkerRegistry(workerRegistry);
  workerRegistry.connectAgentRegistry(agentRegistry);

  const delegationManager = new DelegationManager({ agentRegistry, messageBus, eventBus });
  const remoteTaskBridge = new RemoteTaskBridge({ transport, nodeId, delegationManager });
  messageBus.connectRemoteTaskBridge(remoteTaskBridge);

  const supervisor = new DistributedSupervisor({
    delegationManager,
    eventBus,
    workerRegistry,
    agentRegistry,
  });

  const heartbeatWatchdog = new HeartbeatWatchdog({ workerRegistry, eventBus, timeoutMs: 1000 });
  const eventBridge = new DistributedEventBridge({ eventBus, transport, nodeId });
  eventBridge.start();

  return {
    eventBus,
    transport,
    agentRegistry,
    messageBus,
    workerRegistry,
    delegationManager,
    remoteTaskBridge,
    supervisor,
    heartbeatWatchdog,
    eventBridge,
  };
}

function makeWorkerNode(hub: InMemoryTransportHub, nodeId: string) {
  const eventBus = new EventBus();
  const transport = new InMemoryDistributedTransport(hub);
  const messageBus = new DistributedMessageBus(eventBus, transport, nodeId);
  const agentRegistry = new AgentRegistry(eventBus, messageBus);
  const workerRegistry = new WorkerRegistry({ eventBus, transport, nodeId });
  messageBus.connectWorkerRegistry(workerRegistry);
  workerRegistry.connectAgentRegistry(agentRegistry);

  const remoteTaskBridge = new RemoteTaskBridge({ transport, nodeId });
  messageBus.connectRemoteTaskBridge(remoteTaskBridge);

  const heartbeatSender = new WorkerHeartbeatSender({ workerRegistry, transport, eventBus, nodeId });
  const eventBridge = new DistributedEventBridge({ eventBus, transport, nodeId });
  eventBridge.start();

  return { eventBus, transport, agentRegistry, messageBus, workerRegistry, remoteTaskBridge, heartbeatSender };
}

/** Simulate a worker executing whatever landed in its mailbox: dequeue
 *  the task assignment and report the outcome back over RemoteTaskBridge
 *  — the distributed equivalent of SupervisorAgent.test.ts calling
 *  delegation.complete() directly. */
function drainAndComplete(
  worker: ReturnType<typeof makeWorkerNode>,
  workerId: string,
  outcome: { output?: unknown; error?: string },
): string {
  const envelope = worker.messageBus.getMailbox(workerId).dequeue();
  assert.ok(envelope, 'worker should have received a task assignment');
  const assignment = envelope!.message.payload as TaskAssignment;

  if (outcome.error) {
    worker.remoteTaskBridge.reportFailed(assignment.taskId, outcome.error);
  } else {
    worker.remoteTaskBridge.reportCompleted(assignment.taskId, outcome.output);
  }
  return assignment.taskId;
}

describe('distributed execution end-to-end', () => {
  test('a task submitted on the coordinator executes on a remote worker and settles back', async () => {
    const hub = new InMemoryTransportHub();
    const coordinator = makeCoordinatorNode(hub, 'node-coordinator');
    const worker = makeWorkerNode(hub, 'node-worker');

    worker.workerRegistry.registerLocalWorker({
      id: 'worker-1',
      name: 'Worker One',
      capabilities: ['summarize'],
    });

    const pending = coordinator.supervisor.submitWork({
      title: 'Summarize the report',
      description: 'x',
      requiredCapability: 'summarize',
      payload: { doc: 'q3.pdf' },
    });

    drainAndComplete(worker, 'worker-1', { output: 'a tidy summary' });

    const result = await pending;
    assert.equal(result.status, TaskStatus.Completed);
    assert.equal(result.result, 'a tidy summary');
    assert.equal(result.workerId, 'worker-1');
  });

  test('a remote worker reporting failure fails the task on the coordinator', async () => {
    const hub = new InMemoryTransportHub();
    const coordinator = makeCoordinatorNode(hub, 'node-coordinator');
    const worker = makeWorkerNode(hub, 'node-worker');
    worker.workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });

    const pending = coordinator.supervisor.submitWork({ title: 'Risky', description: 'x' });
    drainAndComplete(worker, 'worker-1', { error: 'could not parse input' });

    const result = await pending;
    assert.equal(result.status, TaskStatus.Failed);
    assert.equal(result.failureReason, 'could not parse input');
  });

  test('retries a remote failure on a worker hosted on a DIFFERENT node', async () => {
    const hub = new InMemoryTransportHub();
    const coordinator = makeCoordinatorNode(hub, 'node-coordinator');
    const workerX = makeWorkerNode(hub, 'node-worker-x');
    const workerY = makeWorkerNode(hub, 'node-worker-y');
    workerX.workerRegistry.registerLocalWorker({ id: 'worker-x', name: 'X' });
    workerY.workerRegistry.registerLocalWorker({ id: 'worker-y', name: 'Y' });

    const pending = coordinator.supervisor.submitWork({
      title: 'Flaky',
      description: 'x',
      maxRetries: 1,
    });

    const [firstTask] = coordinator.delegationManager.listTasks({ status: TaskStatus.Assigned });
    const firstWorkerId = firstTask!.assignedTo!;
    const firstNode = firstWorkerId === 'worker-x' ? workerX : workerY;
    const secondNode = firstWorkerId === 'worker-x' ? workerY : workerX;

    drainAndComplete(firstNode, firstWorkerId, { error: 'transient' });

    const [secondTask] = coordinator.delegationManager.listTasks({ status: TaskStatus.Assigned });
    assert.notEqual(secondTask!.assignedTo, firstWorkerId);

    drainAndComplete(secondNode, secondTask!.assignedTo!, { output: 'ok on retry' });

    const result = await pending;
    assert.equal(result.status, TaskStatus.Completed);
    assert.equal(coordinator.supervisor.getDiagnostics().retried, 1);
  });

  test('a heartbeat timeout on a remote worker fails its in-flight task and is visible to the coordinator', async () => {
    const hub = new InMemoryTransportHub();
    const coordinator = makeCoordinatorNode(hub, 'node-coordinator');
    const worker = makeWorkerNode(hub, 'node-worker');
    worker.workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });

    const workerLostSeenByCoordinator: unknown[] = [];
    coordinator.eventBus.subscribe(EventType.WorkerLost, (envelope) => {
      workerLostSeenByCoordinator.push(envelope.payload);
    });

    const pending = coordinator.supervisor.submitWork({ title: 'Doomed', description: 'x' });
    // Let the assignment cross the wire before going silent.
    assert.equal(worker.messageBus.getMailbox('worker-1').size(), 1);

    // Simulate the worker going silent: its last heartbeat is long ago
    // in the COORDINATOR's own view (the watchdog runs on the
    // coordinator, sweeping its own WorkerRegistry bookkeeping).
    coordinator.workerRegistry.recordHeartbeat('worker-1', new Date(Date.now() - 60_000));
    coordinator.heartbeatWatchdog.sweep(new Date());

    const result = await pending;
    assert.equal(result.status, TaskStatus.Failed);
    assert.match(result.failureReason ?? '', /worker-1/);
    assert.equal(workerLostSeenByCoordinator.length, 1);
  });

  test('capability discovery finds a worker registered on a remote node before any work is submitted', () => {
    const hub = new InMemoryTransportHub();
    const coordinator = makeCoordinatorNode(hub, 'node-coordinator');
    const worker = makeWorkerNode(hub, 'node-worker');

    worker.workerRegistry.registerLocalWorker({
      id: 'worker-1',
      name: 'One',
      capabilities: ['ocr'],
    });

    const found = coordinator.workerRegistry.findByCapability('ocr');
    assert.deepEqual(found.map((w) => w.id), ['worker-1']);
    assert.equal(found[0]?.nodeId, 'node-worker');
  });

  test('framework events on the worker node propagate to the coordinator', () => {
    const hub = new InMemoryTransportHub();
    const coordinator = makeCoordinatorNode(hub, 'node-coordinator');
    const worker = makeWorkerNode(hub, 'node-worker');

    const seen: string[] = [];
    coordinator.eventBus.subscribe(EventType.WorkerRegistered, (envelope) => {
      seen.push(envelope.source);
    });

    worker.workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });

    assert.deepEqual(seen, ['worker:worker-1']);
  });
});
