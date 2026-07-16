import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../agents/AgentRegistry.ts';
import { DelegationManager } from '../delegation/DelegationManager.ts';
import { TaskStatus } from '../delegation/TaskStatus.ts';
import { EventBus } from '../events/EventBus.ts';
import { InMemoryDistributedTransport, InMemoryTransportHub } from './InMemoryDistributedTransport.ts';
import { RemoteTaskBridge } from './RemoteTaskBridge.ts';
import type { AgentMessage } from '../communication/AgentMessage.ts';

function taskAssignmentMessage(taskId: string): AgentMessage {
  return {
    id: 'msg-1',
    fromAgentId: 'coordinator',
    toAgentId: 'worker-1',
    messageType: 'task.assignment',
    correlationId: taskId,
    payload: { taskId },
    createdAt: new Date(),
  };
}

describe('RemoteTaskBridge', () => {
  test('trackOrigin ignores messages that are not task assignments', () => {
    const transport = new InMemoryDistributedTransport();
    const bridge = new RemoteTaskBridge({ transport, nodeId: 'node-b' });

    bridge.trackOrigin(
      { ...taskAssignmentMessage('task-1'), messageType: 'notification' },
      'node-a',
    );

    assert.equal(bridge.getDiagnostics().trackedOrigins, 0);
  });

  test('reporting a result for an untracked taskId does not throw', () => {
    const transport = new InMemoryDistributedTransport();
    const bridge = new RemoteTaskBridge({ transport, nodeId: 'node-b' });

    assert.doesNotThrow(() => bridge.reportCompleted('unknown-task', 'x'));
  });

  test('round-trips started/completed outcomes back into the origin node\'s DelegationManager', () => {
    const hub = new InMemoryTransportHub();

    // Coordinator (node-a): owns the real Task record.
    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry(eventBus);
    agentRegistry.register({ id: 'worker-1', name: 'One', type: 'worker' });
    const delegationManager = new DelegationManager({ agentRegistry, eventBus });
    const task = delegationManager.createTask({
      title: 'Remote work',
      description: 'x',
      assignedBy: 'coordinator',
    });
    delegationManager.assign(task.id, 'worker-1');

    const coordinatorTransport = new InMemoryDistributedTransport(hub);
    new RemoteTaskBridge({ transport: coordinatorTransport, nodeId: 'node-a', delegationManager });

    // Worker (node-b): only knows the taskId and where it came from.
    const workerTransport = new InMemoryDistributedTransport(hub);
    const workerBridge = new RemoteTaskBridge({ transport: workerTransport, nodeId: 'node-b' });
    workerBridge.trackOrigin(taskAssignmentMessage(task.id), 'node-a');

    workerBridge.reportStarted(task.id);
    assert.equal(delegationManager.getTask(task.id).status, TaskStatus.InProgress);

    workerBridge.reportCompleted(task.id, 'the answer');
    const settled = delegationManager.getTask(task.id);
    assert.equal(settled.status, TaskStatus.Completed);
    assert.equal(settled.result?.output, 'the answer');

    // Origin is cleared after a terminal outcome.
    assert.equal(workerBridge.getDiagnostics().trackedOrigins, 0);
  });

  test('reportFailed round-trips into DelegationManager.fail()', () => {
    const hub = new InMemoryTransportHub();

    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry(eventBus);
    agentRegistry.register({ id: 'worker-1', name: 'One', type: 'worker' });
    const delegationManager = new DelegationManager({ agentRegistry, eventBus });
    const task = delegationManager.createTask({
      title: 'Remote work',
      description: 'x',
      assignedBy: 'coordinator',
    });
    delegationManager.assign(task.id, 'worker-1');

    const coordinatorTransport = new InMemoryDistributedTransport(hub);
    new RemoteTaskBridge({ transport: coordinatorTransport, nodeId: 'node-a', delegationManager });

    const workerTransport = new InMemoryDistributedTransport(hub);
    const workerBridge = new RemoteTaskBridge({ transport: workerTransport, nodeId: 'node-b' });
    workerBridge.trackOrigin(taskAssignmentMessage(task.id), 'node-a');

    workerBridge.reportFailed(task.id, 'boom');

    const settled = delegationManager.getTask(task.id);
    assert.equal(settled.status, TaskStatus.Failed);
    assert.equal(settled.result?.error, 'boom');
  });

  test('a result for a task the coordinator no longer recognizes is swallowed, not thrown', () => {
    const hub = new InMemoryTransportHub();

    const eventBus = new EventBus();
    const agentRegistry = new AgentRegistry(eventBus);
    const delegationManager = new DelegationManager({ agentRegistry, eventBus });

    const coordinatorTransport = new InMemoryDistributedTransport(hub);
    new RemoteTaskBridge({ transport: coordinatorTransport, nodeId: 'node-a', delegationManager });

    const workerTransport = new InMemoryDistributedTransport(hub);
    const workerBridge = new RemoteTaskBridge({ transport: workerTransport, nodeId: 'node-b' });
    workerBridge.trackOrigin(taskAssignmentMessage('never-existed'), 'node-a');

    assert.doesNotThrow(() => workerBridge.reportCompleted('never-existed', 'x'));
  });

  test('a bridge with no DelegationManager (pure worker role) ignores incoming results', () => {
    const hub = new InMemoryTransportHub();
    const workerSideTransport = new InMemoryDistributedTransport(hub);
    new RemoteTaskBridge({ transport: workerSideTransport, nodeId: 'node-b' });

    const otherTransport = new InMemoryDistributedTransport(hub);
    const otherBridge = new RemoteTaskBridge({ transport: otherTransport, nodeId: 'node-a' });
    otherBridge.trackOrigin(taskAssignmentMessage('task-x'), 'node-b');

    assert.doesNotThrow(() => otherBridge.reportCompleted('task-x', 'x'));
  });
});
