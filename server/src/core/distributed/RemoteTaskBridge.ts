import { TaskStatus } from '../delegation/TaskStatus.ts';
import { nodeInboxChannel } from './DistributedProtocol.ts';
import type { NodeInboxWireMessage } from './DistributedProtocol.ts';
import type { AgentMessage } from '../communication/AgentMessage.ts';
import type { DelegationManager } from '../delegation/DelegationManager.ts';
import type { DistributedTransport } from './DistributedTransport.ts';
import type { Logger } from '../observability/index.ts';

export interface RemoteTaskBridgeOptions {
  transport: DistributedTransport;
  nodeId: string;
  /** Only needed on the node that owns the tasks being delegated (the
   *  coordinator) — the bridge uses it to turn a received task-result
   *  message into the exact same DelegationManager.updateStatus()/
   *  complete()/fail() calls a purely local worker would trigger
   *  directly (see SupervisorAgent.test.ts's makeFramework() pattern). */
  delegationManager?: DelegationManager;
  logger?: Logger;
}

export interface RemoteTaskBridgeDiagnostics {
  trackedOrigins: number;
}

// Closes the loop DistributedMessageBus opens: when a task assignment is
// forwarded to a worker on another node, something on the WORKER's node
// needs to report the outcome back to the COORDINATOR's DelegationManager
// — the one holding the actual Task record. In the existing in-process
// model a worker reports outcomes by calling delegationManager methods
// directly (see SupervisorAgent.test.ts); across a node boundary that
// call has to travel over the transport instead. RemoteTaskBridge is
// that call, split across the wire: reportStarted/Completed/Failed()
// publish from the worker's node, and the same class (constructed on
// every node) turns the resulting wire message back into the ordinary
// DelegationManager call on the coordinator's node.
export class RemoteTaskBridge {
  private readonly transport: DistributedTransport;
  private readonly nodeId: string;
  private readonly delegationManager: DelegationManager | undefined;
  private readonly logger: Logger | undefined;
  private readonly origins = new Map<string, string>();

  constructor(options: RemoteTaskBridgeOptions) {
    this.transport = options.transport;
    this.nodeId = options.nodeId;
    this.delegationManager = options.delegationManager;
    this.logger = options.logger;

    this.transport.subscribe(nodeInboxChannel(this.nodeId), (raw) => {
      const message = raw as NodeInboxWireMessage;
      if (message.kind === 'task-result') {
        this.applyResult(message);
      }
    });
  }

  /** Remember which node a forwarded task-assignment message came from,
   *  keyed by taskId, so reportStarted/Completed/Failed() know where to
   *  send the outcome without the caller having to track it. Called by
   *  DistributedMessageBus right after it delivers a forwarded
   *  task.assignment message into a real local mailbox. A no-op for any
   *  message that is not a task assignment (nothing to track). */
  trackOrigin(message: AgentMessage, originNodeId: string): void {
    if (message.messageType !== 'task.assignment') {
      return;
    }
    const taskId = (message.payload as { taskId?: string } | null)?.taskId;
    if (taskId) {
      this.origins.set(taskId, originNodeId);
    }
  }

  reportStarted(taskId: string): void {
    this.send(taskId, { outcome: 'started' });
  }

  reportCompleted(taskId: string, output?: unknown): void {
    this.send(taskId, { outcome: 'completed', output });
    this.origins.delete(taskId);
  }

  reportFailed(taskId: string, error: string): void {
    this.send(taskId, { outcome: 'failed', error });
    this.origins.delete(taskId);
  }

  getDiagnostics(): RemoteTaskBridgeDiagnostics {
    return { trackedOrigins: this.origins.size };
  }

  private send(
    taskId: string,
    outcome: { outcome: 'started' | 'completed' | 'failed'; output?: unknown; error?: string },
  ): void {
    const originNodeId = this.origins.get(taskId);
    if (!originNodeId) {
      this.logger?.warn('No known origin node for remote task result', { taskId });
      return;
    }

    this.transport.publish(nodeInboxChannel(originNodeId), {
      kind: 'task-result',
      originNodeId: this.nodeId,
      taskId,
      ...outcome,
    } satisfies NodeInboxWireMessage);
  }

  private applyResult(message: Extract<NodeInboxWireMessage, { kind: 'task-result' }>): void {
    if (!this.delegationManager) {
      return;
    }

    try {
      switch (message.outcome) {
        case 'started':
          this.delegationManager.updateStatus(message.taskId, TaskStatus.InProgress);
          break;
        case 'completed':
          this.delegationManager.complete(message.taskId, message.output);
          break;
        case 'failed':
          this.delegationManager.fail(message.taskId, message.error ?? 'Remote task failed.');
          break;
      }
    } catch (error) {
      // A result for a task we no longer track (already retried/failed
      // some other way) is not fatal — log and move on, mirroring
      // MessageBus's push-handler isolation.
      this.logger?.warn('Failed to apply remote task result', {
        taskId: message.taskId,
        outcome: message.outcome,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
