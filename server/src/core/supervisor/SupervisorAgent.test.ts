import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorAgent } from './SupervisorAgent.ts';
import { LeastLoadedRoutingStrategy } from './LeastLoadedRoutingStrategy.ts';
import { AgentRegistry } from '../agents/AgentRegistry.ts';
import { DelegationManager } from '../delegation/DelegationManager.ts';
import { MessageBus } from '../communication/MessageBus.ts';
import { EventBus } from '../events/EventBus.ts';
import { EventType } from '../events/EventType.ts';
import { TaskStatus } from '../delegation/TaskStatus.ts';
import type { WorkerCandidate } from './RoutingStrategy.ts';

function candidate(
  agentId: string,
  activeAssignments: number,
  available = true,
): WorkerCandidate {
  return { agentId, activeAssignments, available };
}

describe('least-loaded routing strategy', () => {
  const strategy = new LeastLoadedRoutingStrategy();

  test('selects the worker with the fewest active assignments', () => {
    assert.equal(
      strategy.selectWorker([
        candidate('busy', 5),
        candidate('idle', 0),
        candidate('medium', 2),
      ]),
      'idle',
    );
  });

  test('ignores unavailable agents even when they are least loaded', () => {
    assert.equal(
      strategy.selectWorker([
        candidate('dead-but-idle', 0, false),
        candidate('alive', 3),
      ]),
      'alive',
    );
  });

  test('breaks ties alphabetically for deterministic routing', () => {
    assert.equal(
      strategy.selectWorker([candidate('zed', 1), candidate('alpha', 1)]),
      'alpha',
    );
  });

  test('returns null when nothing qualifies', () => {
    assert.equal(strategy.selectWorker([]), null);
    assert.equal(strategy.selectWorker([candidate('dead', 0, false)]), null);
  });
});

// A fully wired framework core for supervisor scenarios.
function makeFramework() {
  const eventBus = new EventBus();
  const messageBus = new MessageBus(eventBus);
  const registry = new AgentRegistry(eventBus, messageBus);
  const delegation = new DelegationManager({
    agentRegistry: registry,
    messageBus,
    eventBus,
  });
  const supervisor = new SupervisorAgent({
    agentRegistry: registry,
    delegationManager: delegation,
    eventBus,
  });

  return { eventBus, messageBus, registry, delegation, supervisor };
}

function registerWorker(registry: AgentRegistry, id: string) {
  registry.register({ id, name: `Worker ${id}`, type: 'worker' });
}

describe('supervisor orchestration', () => {
  test('registers itself and never routes to itself', () => {
    const { registry, supervisor } = makeFramework();

    assert.equal(registry.exists('supervisor'), true);
    assert.equal(registry.get('supervisor').type, 'supervisor');
    assert.equal(supervisor.selectWorker(), null, 'no workers registered yet');
  });

  test('submitWork delegates, delivers the assignment, and resolves on completion', async () => {
    const { messageBus, registry, delegation, supervisor } = makeFramework();
    registerWorker(registry, 'worker-1');

    const pending = supervisor.submitWork({
      title: 'Summarize',
      description: 'Summarize the report.',
      payload: { doc: 'q3.pdf' },
    });

    // The worker finds its assignment in the mailbox.
    const envelope = messageBus.getMailbox('worker-1').dequeue();
    const assignment = envelope?.message.payload as { taskId: string };
    assert.equal(envelope?.message.messageType, 'task.assignment');

    // Worker executes and reports through the delegation manager.
    delegation.updateStatus(assignment.taskId, TaskStatus.InProgress);
    delegation.complete(assignment.taskId, 'the summary');

    const result = await pending;
    assert.deepEqual(result, {
      taskId: assignment.taskId,
      workerId: 'worker-1',
      status: TaskStatus.Completed,
      result: 'the summary',
      failureReason: null,
    });
  });

  test('failed work resolves with the failure reason', async () => {
    const { registry, delegation, supervisor } = makeFramework();
    registerWorker(registry, 'worker-1');

    const pending = supervisor.submitWork({ title: 'Risky', description: 'x' });
    const [task] = delegation.listTasks({ assignedTo: 'worker-1' });
    delegation.fail(task!.id, 'worker could not parse input');

    const result = await pending;
    assert.equal(result.status, TaskStatus.Failed);
    assert.equal(result.failureReason, 'worker could not parse input');
    assert.equal(result.result, null);
  });

  test('no available workers cancels the task with an honest result', async () => {
    const { delegation, supervisor } = makeFramework();

    const result = await supervisor.submitWork({ title: 'Orphan', description: 'x' });

    assert.equal(result.status, TaskStatus.Cancelled);
    assert.equal(result.workerId, null);
    assert.match(result.failureReason ?? '', /No available "worker" agent/);
    assert.equal(delegation.getTask(result.taskId).status, TaskStatus.Cancelled);
  });

  test('routing spreads load across workers', async () => {
    const { registry, supervisor } = makeFramework();
    registerWorker(registry, 'worker-a');
    registerWorker(registry, 'worker-b');

    void supervisor.submitWork({ title: 'One', description: 'x' });
    void supervisor.submitWork({ title: 'Two', description: 'x' });
    void supervisor.submitWork({ title: 'Three', description: 'x' });

    assert.deepEqual(supervisor.getDiagnostics().workerUtilization, {
      'worker-a': 2,
      'worker-b': 1,
    });
  });

  test('a failed worker agent fails all its active supervised tasks', async () => {
    const { eventBus, registry, supervisor } = makeFramework();
    registerWorker(registry, 'worker-1');
    registerWorker(registry, 'worker-2');

    const onDoomed = supervisor.submitWork({ title: 'Doomed', description: 'x' });
    const onSafe = supervisor.submitWork({ title: 'Safe', description: 'x' });

    // worker-1 (alphabetically first, least loaded) got "Doomed".
    eventBus.publish({ type: EventType.AgentFailed, source: 'agent:worker-1' });

    const doomed = await onDoomed;
    assert.equal(doomed.status, TaskStatus.Failed);
    assert.match(doomed.failureReason ?? '', /Worker agent "worker-1" failed/);

    // worker-2's task is untouched and still active.
    const diagnostics = supervisor.getDiagnostics();
    assert.equal(diagnostics.active, 1);
    assert.deepEqual(diagnostics.workerUtilization, { 'worker-2': 1 });
    void onSafe;
  });

  test('events for tasks the supervisor did not delegate are ignored', () => {
    const { delegation, supervisor } = makeFramework();

    // A task created and completed outside the supervisor.
    const outside = delegation.createTask({
      title: 'Outside',
      description: 'x',
      assignedBy: 'someone-else',
    });
    delegation.assign(outside.id, 'supervisor'); // any registered agent
    delegation.complete(outside.id, 'done elsewhere');

    assert.equal(supervisor.getDiagnostics().supervisedTasks, 0);
  });

  test('diagnostics count outcomes across supervised work', async () => {
    const { registry, delegation, supervisor } = makeFramework();
    registerWorker(registry, 'worker-1');

    const first = supervisor.submitWork({ title: 'One', description: 'x' });
    const [taskOne] = delegation.listTasks({ status: TaskStatus.Assigned });
    delegation.complete(taskOne!.id, 'ok');
    await first;

    const second = supervisor.submitWork({ title: 'Two', description: 'x' });
    const [taskTwo] = delegation.listTasks({ status: TaskStatus.Assigned });
    delegation.fail(taskTwo!.id, 'nope');
    await second;

    void supervisor.submitWork({ title: 'Three', description: 'x' });

    assert.deepEqual(supervisor.getDiagnostics(), {
      supervisedTasks: 3,
      active: 1,
      completed: 1,
      failed: 1,
      workerUtilization: { 'worker-1': 1 },
    });
  });
});
