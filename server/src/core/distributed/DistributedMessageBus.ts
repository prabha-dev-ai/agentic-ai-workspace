import { randomUUID } from 'node:crypto';
import { MessageBus } from '../communication/MessageBus.ts';
import { EventType } from '../events/EventType.ts';
import { nodeInboxChannel } from './DistributedProtocol.ts';
import type { NodeInboxWireMessage } from './DistributedProtocol.ts';
import type { AgentMessage, MessageDraft } from '../communication/AgentMessage.ts';
import type { DistributedTransport } from './DistributedTransport.ts';
import type { EventBus } from '../events/EventBus.ts';
import type { Logger } from '../observability/index.ts';
import type { MetricsRegistry } from '../metrics/index.ts';
import type { RemoteTaskBridge } from './RemoteTaskBridge.ts';
import type { WorkerRegistry } from './WorkerRegistry.ts';

export interface DistributedMessageBusOptions {
  logger?: Logger;
  metrics?: MetricsRegistry;
}

// Remote task delegation, transport-layer half: a drop-in MessageBus
// (same public surface, same TOKENS.messageBus binding — see
// core/bootstrap.ts) that forwards send() over the DistributedTransport
// instead of throwing "no mailbox" when the recipient is a worker
// registered on ANOTHER node. DelegationManager.assign() — completely
// unmodified — keeps calling messageBus.send(); this subclass is the
// only thing that knows some of those sends now cross a network boundary.
//
// WorkerRegistry is connected AFTER construction (connectWorkerRegistry),
// not through the constructor, to avoid a MessageBus -> WorkerRegistry ->
// AgentRegistry -> MessageBus construction cycle — see WorkerRegistry's
// class doc comment for the full reasoning. Until connected, this class
// behaves exactly like a plain MessageBus.
export class DistributedMessageBus extends MessageBus {
  private readonly transport: DistributedTransport;
  private readonly nodeId: string;
  private readonly distributedEventBus: EventBus | undefined;
  private readonly logger: Logger | undefined;
  private readonly metrics: MetricsRegistry | undefined;
  private workerRegistry: WorkerRegistry | undefined;
  private remoteTaskBridge: RemoteTaskBridge | undefined;

  constructor(
    eventBus: EventBus | undefined,
    transport: DistributedTransport,
    nodeId: string,
    options: DistributedMessageBusOptions = {},
  ) {
    super(eventBus);
    this.distributedEventBus = eventBus;
    this.transport = transport;
    this.nodeId = nodeId;
    this.logger = options.logger;
    this.metrics = options.metrics;

    this.transport.subscribe(nodeInboxChannel(this.nodeId), (raw) => {
      const message = raw as NodeInboxWireMessage;
      if (message.kind === 'task-message') {
        this.deliverForwarded(message);
      }
    });
  }

  connectWorkerRegistry(workerRegistry: WorkerRegistry): void {
    this.workerRegistry = workerRegistry;
  }

  connectRemoteTaskBridge(remoteTaskBridge: RemoteTaskBridge): void {
    this.remoteTaskBridge = remoteTaskBridge;
  }

  override send(draft: MessageDraft): AgentMessage {
    const location = this.workerRegistry?.locate(draft.toAgentId);

    if (!location || location.nodeId === this.nodeId) {
      // Local recipient (or unknown — let the base class's normal
      // "no mailbox" error surface exactly as it does today).
      return super.send(draft);
    }

    return this.forward(draft, location.nodeId);
  }

  private forward(draft: MessageDraft, targetNodeId: string): AgentMessage {
    const message: AgentMessage = {
      id: randomUUID(),
      fromAgentId: draft.fromAgentId,
      toAgentId: draft.toAgentId,
      messageType: draft.messageType,
      correlationId: draft.correlationId ?? randomUUID(),
      payload: draft.payload ?? null,
      createdAt: new Date(),
    };

    this.transport.publish(nodeInboxChannel(targetNodeId), {
      kind: 'task-message',
      originNodeId: this.nodeId,
      message,
    } satisfies NodeInboxWireMessage);

    this.distributedEventBus?.publish({
      type: EventType.MessageSent,
      source: 'distributed-message-bus',
      correlationId: message.correlationId,
      payload: {
        messageId: message.id,
        fromAgentId: message.fromAgentId,
        toAgentId: message.toAgentId,
        messageType: message.messageType,
        targetNodeId,
      },
    });

    if (message.messageType === 'task.assignment') {
      this.distributedEventBus?.publish({
        type: EventType.TaskDelegatedRemote,
        source: 'distributed-message-bus',
        correlationId: message.correlationId,
        payload: {
          taskId: (message.payload as { taskId?: string } | null)?.taskId,
          toAgentId: message.toAgentId,
          targetNodeId,
        },
      });
      this.metrics?.counter('distributed.tasks.delegated_remote').inc();
    }

    this.logger?.info('Forwarded message to remote node', {
      toAgentId: message.toAgentId,
      targetNodeId,
      messageType: message.messageType,
    });

    return message;
  }

  private deliverForwarded(message: Extract<NodeInboxWireMessage, { kind: 'task-message' }>): void {
    // Isolated like MessageBus's own push-handler delivery: a forwarded
    // message that can't land locally (e.g. the target worker
    // unregistered mid-flight) must not throw back through the
    // transport's synchronous delivery loop into the SENDER's send()
    // call on a completely different node.
    try {
      const delivered = super.send({
        fromAgentId: message.message.fromAgentId,
        toAgentId: message.message.toAgentId,
        messageType: message.message.messageType,
        correlationId: message.message.correlationId,
        payload: message.message.payload,
      });

      this.remoteTaskBridge?.trackOrigin(delivered, message.originNodeId);
    } catch (error) {
      this.logger?.error('Failed to deliver forwarded message locally', {
        toAgentId: message.message.toAgentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
