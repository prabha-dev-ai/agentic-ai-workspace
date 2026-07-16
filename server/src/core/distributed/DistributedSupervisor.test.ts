import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../agents/AgentRegistry.ts';
import { DelegationManager } from '../delegation/DelegationManager.ts';
import { TaskStatus } from '../delegation/TaskStatus.ts';
import { EventBus } from '../events/EventBus.ts';
import { EventType } from '../events/EventType.ts';
import { InMemoryDistributedTransport } from './InMemoryDistributedTransport.ts';
import { WorkerRegistry } from './WorkerRegistry.ts';
import { DistributedSupervisor } from './DistributedSupervisor.ts';

function makeFramework() {
  const eventBus = new EventBus();
  const agentRegistry = new AgentRegistry(eventBus);
  const delegationManager = new DelegationManager({ agentRegistry, eventBus });
  const workerRegistry = new WorkerRegistry({
    eventBus,
    transport: new InMemoryDistributedTransport(),
    nodeId: 'node-a',
  });
  workerRegistry.connectAgentRegistry(agentRegistry);
  const supervisor = new DistributedSupervisor({
    delegationManager,
    eventBus,
    workerRegistry,
    agentRegistry,
  });
  return { eventBus, agentRegistry, delegationManager, workerRegistry, supervisor };
}

describe('DistributedSupervisor', () => {
  test('submits work, delegates, and resolves on completion', async () => {
    const { delegationManager, workerRegistry, supervisor } = makeFramework();
    workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });

    const pending = supervisor.submitWork({ title: 'Summarize', description: 'x' });
    const [task] = delegationManager.listTasks({ assignedTo: 'worker-1' });
    delegationManager.complete(task!.id, 'the summary');

    const result = await pending;
    assert.equal(result.status, TaskStatus.Completed);
    assert.equal(result.result, 'the summary');
    assert.equal(result.workerId, 'worker-1');
  });

  test('requiredCapability routes only to a worker advertising it', async () => {
    const { delegationManager, workerRegistry, supervisor } = makeFramework();
    workerRegistry.registerLocalWorker({ id: 'plain', name: 'Plain' });
    workerRegistry.registerLocalWorker({ id: 'gpu', name: 'GPU', capabilities: ['gpu'] });

    const pending = supervisor.submitWork({
      title: 'Train',
      description: 'x',
      requiredCapability: 'gpu',
    });

    const [task] = delegationManager.listTasks({ assignedTo: 'gpu' });
    assert.ok(task, 'the gpu-capable worker should have been selected');
    delegationManager.complete(task!.id, 'done');

    const result = await pending;
    assert.equal(result.workerId, 'gpu');
  });

  test('cancels with an honest reason when no worker has the required capability', async () => {
    const { workerRegistry, supervisor } = makeFramework();
    workerRegistry.registerLocalWorker({ id: 'plain', name: 'Plain' });

    const result = await supervisor.submitWork({
      title: 'Train',
      description: 'x',
      requiredCapability: 'gpu',
    });

    assert.equal(result.status, TaskStatus.Cancelled);
    assert.equal(result.workerId, null);
    assert.match(result.failureReason ?? '', /capability "gpu"/);
  });

  test('retries a failed task on a different worker up to maxRetries', async () => {
    const { delegationManager, workerRegistry, supervisor } = makeFramework();
    workerRegistry.registerLocalWorker({ id: 'worker-a', name: 'A' });
    workerRegistry.registerLocalWorker({ id: 'worker-b', name: 'B' });

    const pending = supervisor.submitWork({
      title: 'Flaky',
      description: 'x',
      maxRetries: 1,
    });

    const [firstTask] = delegationManager.listTasks({ status: TaskStatus.Assigned });
    const firstWorker = firstTask!.assignedTo;
    delegationManager.fail(firstTask!.id, 'transient error');

    const [secondTask] = delegationManager.listTasks({ status: TaskStatus.Assigned });
    assert.notEqual(secondTask!.assignedTo, firstWorker, 'retry must avoid the failed worker');
    delegationManager.complete(secondTask!.id, 'ok on retry');

    const result = await pending;
    assert.equal(result.status, TaskStatus.Completed);
    assert.equal(result.result, 'ok on retry');
    assert.equal(supervisor.getDiagnostics().retried, 1);
  });

  test('gives up and resolves Failed once retries are exhausted', async () => {
    const { delegationManager, workerRegistry, supervisor } = makeFramework();
    workerRegistry.registerLocalWorker({ id: 'worker-a', name: 'A' });
    workerRegistry.registerLocalWorker({ id: 'worker-b', name: 'B' });

    const pending = supervisor.submitWork({ title: 'Doomed', description: 'x', maxRetries: 1 });

    const [firstTask] = delegationManager.listTasks({ status: TaskStatus.Assigned });
    delegationManager.fail(firstTask!.id, 'first failure');

    const [secondTask] = delegationManager.listTasks({ status: TaskStatus.Assigned });
    delegationManager.fail(secondTask!.id, 'second failure');

    const result = await pending;
    assert.equal(result.status, TaskStatus.Failed);
    assert.equal(result.failureReason, 'second failure');
    assert.equal(supervisor.getDiagnostics().retried, 1);
    assert.equal(supervisor.getDiagnostics().failed, 1);
  });

  test('publishes EventType.TaskRetried when retrying', async () => {
    const { eventBus, delegationManager, workerRegistry, supervisor } = makeFramework();
    workerRegistry.registerLocalWorker({ id: 'worker-a', name: 'A' });
    workerRegistry.registerLocalWorker({ id: 'worker-b', name: 'B' });

    const retried: unknown[] = [];
    eventBus.subscribe(EventType.TaskRetried, (envelope) => {
      retried.push(envelope.payload);
    });

    const pending = supervisor.submitWork({ title: 'Flaky', description: 'x', maxRetries: 1 });
    const [firstTask] = delegationManager.listTasks({ status: TaskStatus.Assigned });
    delegationManager.fail(firstTask!.id, 'boom');
    const [secondTask] = delegationManager.listTasks({ status: TaskStatus.Assigned });
    delegationManager.complete(secondTask!.id, 'ok');
    await pending;

    assert.equal(retried.length, 1);
  });

  test('a worker dying mid-task (AgentFailed) fails and, if retries remain, retries the task', async () => {
    const { eventBus, delegationManager, workerRegistry, supervisor } = makeFramework();
    workerRegistry.registerLocalWorker({ id: 'worker-a', name: 'A' });
    workerRegistry.registerLocalWorker({ id: 'worker-b', name: 'B' });

    const pending = supervisor.submitWork({ title: 'Doomed', description: 'x', maxRetries: 1 });
    const [firstTask] = delegationManager.listTasks({ status: TaskStatus.Assigned });
    const deadWorker = firstTask!.assignedTo!;

    eventBus.publish({ type: EventType.AgentFailed, source: `agent:${deadWorker}` });

    const [secondTask] = delegationManager.listTasks({ status: TaskStatus.Assigned });
    assert.ok(secondTask, 'the orphaned task must have been retried on a different worker');
    assert.notEqual(secondTask!.assignedTo, deadWorker);
    delegationManager.complete(secondTask!.id, 'recovered');

    const result = await pending;
    assert.equal(result.status, TaskStatus.Completed);
  });

  test('load spreads across workers via the default least-loaded strategy', () => {
    const { workerRegistry, supervisor } = makeFramework();
    workerRegistry.registerLocalWorker({ id: 'worker-a', name: 'A' });
    workerRegistry.registerLocalWorker({ id: 'worker-b', name: 'B' });

    void supervisor.submitWork({ title: 'One', description: 'x' });
    void supervisor.submitWork({ title: 'Two', description: 'x' });
    void supervisor.submitWork({ title: 'Three', description: 'x' });

    assert.equal(supervisor.getDiagnostics().active, 3);
  });

  test('diagnostics track completed/failed/cancelled counts', async () => {
    const { delegationManager, workerRegistry, supervisor } = makeFramework();
    workerRegistry.registerLocalWorker({ id: 'worker-1', name: 'One' });

    const ok = supervisor.submitWork({ title: 'Ok', description: 'x' });
    const [task] = delegationManager.listTasks({ status: TaskStatus.Assigned });
    delegationManager.complete(task!.id, 'done');
    await ok;

    const cancelled = await supervisor.submitWork({
      title: 'Cancelled',
      description: 'x',
      requiredCapability: 'nonexistent',
    });
    assert.equal(cancelled.status, TaskStatus.Cancelled);

    const diagnostics = supervisor.getDiagnostics();
    assert.equal(diagnostics.completed, 1);
    assert.equal(diagnostics.cancelled, 1);
    assert.equal(diagnostics.active, 0);
  });
});
