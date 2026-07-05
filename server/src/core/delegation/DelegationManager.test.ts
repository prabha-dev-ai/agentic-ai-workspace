import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DelegationManager } from './DelegationManager.ts';
import { TaskStatus } from './TaskStatus.ts';
import { AgentRegistry } from '../agents/AgentRegistry.ts';
import { MessageBus } from '../communication/MessageBus.ts';
import { EventBus } from '../events/EventBus.ts';
import { EventType } from '../events/EventType.ts';
import type { TaskAssignment } from './TaskAssignment.ts';

function draft(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Summarize the report',
    description: 'Produce a one-paragraph summary.',
    assignedBy: 'orchestrator',
    ...overrides,
  };
}

describe('task creation', () => {
  test('stamps the task and starts it in Created', () => {
    const manager = new DelegationManager();

    const task = manager.createTask(
      draft({ payload: { doc: 'q3.pdf' }, metadata: { priority: 'high' } }),
    );

    assert.ok(task.id.length > 0);
    assert.equal(task.status, TaskStatus.Created);
    assert.equal(task.assignedTo, null);
    assert.equal(task.correlationId, task.id, 'self-correlated by default');
    assert.deepEqual(task.payload, { doc: 'q3.pdf' });
    assert.deepEqual(task.metadata, { priority: 'high' });
    assert.ok(task.createdAt instanceof Date);
    assert.equal(manager.getTask(task.id), task);
  });

  test('rejects blank titles and assigners', () => {
    const manager = new DelegationManager();

    assert.throws(() => manager.createTask(draft({ title: ' ' })), /non-empty title/);
    assert.throws(
      () => manager.createTask(draft({ assignedBy: '' })),
      /non-empty assignedBy/,
    );
  });
});

describe('assignment', () => {
  test('validates the assignee against the registry', () => {
    const registry = new AgentRegistry();
    registry.register({ id: 'worker-1', name: 'Worker', type: 'worker' });
    const manager = new DelegationManager({ agentRegistry: registry });
    const task = manager.createTask(draft());

    assert.throws(
      () => manager.assign(task.id, 'ghost'),
      /agent "ghost" is not registered/,
    );
    assert.equal(task.status, TaskStatus.Created, 'failed validation changes nothing');

    manager.assign(task.id, 'worker-1');
    assert.equal(task.status, TaskStatus.Assigned);
    assert.equal(task.assignedTo, 'worker-1');
  });

  test('delivers the assignment as a structured message', () => {
    const eventBus = new EventBus();
    const messageBus = new MessageBus(eventBus);
    const registry = new AgentRegistry(eventBus, messageBus);
    registry.register({ id: 'worker-1', name: 'Worker', type: 'worker' });

    const manager = new DelegationManager({ agentRegistry: registry, messageBus });
    const task = manager.createTask(draft({ payload: { doc: 'q3.pdf' } }));
    manager.assign(task.id, 'worker-1');

    const envelope = messageBus.getMailbox('worker-1').dequeue();
    assert.equal(envelope?.message.messageType, 'task.assignment');
    assert.equal(envelope?.message.fromAgentId, 'orchestrator');
    assert.equal(envelope?.message.correlationId, task.correlationId);

    const assignment = envelope?.message.payload as TaskAssignment;
    assert.equal(assignment.taskId, task.id);
    assert.equal(assignment.title, 'Summarize the report');
    assert.deepEqual(assignment.payload, { doc: 'q3.pdf' });
  });

  test('rolls back when message delivery fails', () => {
    // MessageBus without the recipient's mailbox (no registry wiring).
    const messageBus = new MessageBus();
    const manager = new DelegationManager({ messageBus });
    const task = manager.createTask(draft());

    assert.throws(() => manager.assign(task.id, 'worker-1'), /no mailbox/);
    assert.equal(task.status, TaskStatus.Created, 'assignment rolled back');
    assert.equal(task.assignedTo, null);
  });

  test('unknown tasks and double assignment are rejected', () => {
    const manager = new DelegationManager();
    const task = manager.createTask(draft());
    manager.assign(task.id, 'worker-1');

    assert.throws(() => manager.assign('ghost', 'worker-1'), /Unknown task/);
    assert.throws(
      () => manager.assign(task.id, 'worker-2'),
      /Invalid task transition "assigned" -> "assigned"/,
    );
  });
});

describe('task state machine', () => {
  test('the full happy path publishes the full event story', () => {
    const eventBus = new EventBus();
    const seen: { type: string; correlationId: string }[] = [];
    eventBus.subscribe('*', (envelope) => {
      seen.push({ type: envelope.type, correlationId: envelope.correlationId });
    });

    const manager = new DelegationManager({ eventBus });
    const task = manager.createTask(draft());
    manager.assign(task.id, 'worker-1');
    manager.updateStatus(task.id, TaskStatus.InProgress);
    manager.complete(task.id, { summary: 'done' });

    assert.deepEqual(
      seen.map((event) => event.type),
      [
        EventType.TaskCreated,
        EventType.TaskAssigned,
        EventType.TaskStarted,
        EventType.TaskCompleted,
      ],
    );
    assert.ok(seen.every((event) => event.correlationId === task.correlationId));

    assert.equal(task.status, TaskStatus.Completed);
    assert.deepEqual(task.result?.output, { summary: 'done' });
    assert.equal(task.result?.error, null);
    assert.ok(task.result?.finishedAt instanceof Date);
  });

  test('failures and cancellations record their reasons', () => {
    const manager = new DelegationManager();

    const failing = manager.createTask(draft());
    manager.assign(failing.id, 'worker-1');
    manager.fail(failing.id, 'worker exploded');
    assert.equal(failing.status, TaskStatus.Failed);
    assert.equal(failing.result?.error, 'worker exploded');

    const cancelled = manager.createTask(draft());
    manager.cancel(cancelled.id, 'no longer needed');
    assert.equal(cancelled.status, TaskStatus.Cancelled);
    assert.equal(cancelled.result?.error, 'no longer needed');
  });

  test('invalid transitions are rejected with valid targets listed', () => {
    const manager = new DelegationManager();
    const task = manager.createTask(draft());

    assert.throws(
      () => manager.updateStatus(task.id, TaskStatus.InProgress),
      /Invalid task transition "created" -> "in-progress"/,
    );

    manager.assign(task.id, 'worker-1');
    manager.complete(task.id);
    assert.throws(() => manager.fail(task.id, 'too late'), /Valid targets: \(none\)/);
  });
});

describe('queries and diagnostics', () => {
  test('listTasks filters by status and assignee', () => {
    const manager = new DelegationManager();
    const a = manager.createTask(draft({ title: 'A' }));
    const b = manager.createTask(draft({ title: 'B' }));
    manager.createTask(draft({ title: 'C' }));
    manager.assign(a.id, 'worker-1');
    manager.assign(b.id, 'worker-1');
    manager.complete(a.id);

    assert.equal(manager.listTasks().length, 3);
    assert.deepEqual(
      manager.listTasks({ assignedTo: 'worker-1', status: TaskStatus.Assigned }).map((t) => t.title),
      ['B'],
    );
    assert.equal(manager.listTasks({ status: TaskStatus.Created }).length, 1);
  });

  test('diagnostics count states and active assignments per agent', () => {
    const manager = new DelegationManager();

    const done = manager.createTask(draft());
    manager.assign(done.id, 'worker-1');
    manager.complete(done.id);

    const failed = manager.createTask(draft());
    manager.assign(failed.id, 'worker-2');
    manager.fail(failed.id, 'x');

    const activeOne = manager.createTask(draft());
    manager.assign(activeOne.id, 'worker-1');
    const activeTwo = manager.createTask(draft());
    manager.assign(activeTwo.id, 'worker-1');
    manager.updateStatus(activeTwo.id, TaskStatus.InProgress);

    manager.createTask(draft()); // unassigned, active

    assert.deepEqual(manager.getDiagnostics(), {
      active: 3,
      completed: 1,
      failed: 1,
      cancelled: 0,
      total: 5,
      assignmentsPerAgent: { 'worker-1': 2 },
    });
  });
});

describe('end-to-end delegation', () => {
  test('registry + message bus + event bus compose into one delegation flow', () => {
    const eventBus = new EventBus();
    const messageBus = new MessageBus(eventBus);
    const registry = new AgentRegistry(eventBus, messageBus);
    const manager = new DelegationManager({
      agentRegistry: registry,
      messageBus,
      eventBus,
    });

    registry.register({ id: 'orchestrator', name: 'Orchestrator', type: 'supervisor' });
    registry.register({ id: 'worker-1', name: 'Worker', type: 'worker' });

    // Orchestrator delegates; worker finds the assignment in its mailbox.
    const task = manager.createTask(draft());
    manager.assign(task.id, 'worker-1');

    const assignment = messageBus.getMailbox('worker-1').dequeue()?.message
      .payload as TaskAssignment;
    assert.equal(assignment.taskId, task.id);

    // Worker reports progress and completion through the manager.
    manager.updateStatus(assignment.taskId, TaskStatus.InProgress);
    manager.complete(assignment.taskId, 'summary text');

    assert.equal(manager.getTask(task.id).status, TaskStatus.Completed);
    assert.equal(manager.getTask(task.id).result?.output, 'summary text');

    // The event log tells the whole story, task and message events alike.
    const types = eventBus.getDiagnostics();
    assert.ok(types.publishedEvents >= 6, 'task + message events all published');
  });
});
