import { randomUUID } from 'node:crypto';
import { Mailbox } from './Mailbox.ts';
import { EventType } from '../events/EventType.ts';
import type { AgentMessage, MessageDraft } from './AgentMessage.ts';
import type { MessageEnvelope } from './MessageEnvelope.ts';
import type { MessageHandler } from './MessageHandler.ts';
import type { EventBus } from '../events/EventBus.ts';

export interface MessageBusDiagnostics {
  totalSent: number;
  delivered: number;
  undeliverable: number;
  activeMailboxes: number;
  /** Pending message counts per agent id. */
  queueSizes: Record<string, number>;
}

// Point-to-point messaging between registered agents. Every agent gets a
// FIFO mailbox (provisioned by the AgentRegistry on registration); the
// bus stamps, delivers, and reports every attempt as framework events.
export class MessageBus {
  private readonly mailboxes = new Map<
    string,
    { mailbox: Mailbox; handler: MessageHandler | undefined }
  >();
  private readonly eventBus: EventBus | undefined;
  private totalSent = 0;
  private delivered = 0;
  private undeliverable = 0;

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus;
  }

  registerMailbox(agentId: string, handler?: MessageHandler): Mailbox {
    if (agentId.trim() === '') {
      throw new Error('A mailbox needs a non-empty agent id.');
    }

    if (this.mailboxes.has(agentId)) {
      throw new Error(`Agent "${agentId}" already has a mailbox.`);
    }

    const mailbox = new Mailbox();
    this.mailboxes.set(agentId, { mailbox, handler });
    return mailbox;
  }

  unregisterMailbox(agentId: string): void {
    if (!this.mailboxes.delete(agentId)) {
      throw new Error(`Agent "${agentId}" has no mailbox.`);
    }
  }

  hasMailbox(agentId: string): boolean {
    return this.mailboxes.has(agentId);
  }

  getMailbox(agentId: string): Mailbox {
    const entry = this.mailboxes.get(agentId);

    if (!entry) {
      throw new Error(`Agent "${agentId}" has no mailbox.`);
    }

    return entry.mailbox;
  }

  /**
   * Send one message. Undeliverable messages (recipient has no mailbox)
   * are counted, reported as message.failed, and thrown — the sender
   * must know its message went nowhere.
   */
  send(draft: MessageDraft): AgentMessage {
    const message = this.stamp(draft);

    this.totalSent++;
    this.publish(EventType.MessageSent, message);

    const entry = this.mailboxes.get(message.toAgentId);

    if (!entry) {
      this.undeliverable++;
      this.publish(EventType.MessageFailed, message, {
        reason: `agent "${message.toAgentId}" has no mailbox`,
      });
      throw new Error(
        `Cannot deliver message to agent "${message.toAgentId}": no mailbox registered.`,
      );
    }

    const envelope: MessageEnvelope = { message, deliveredAt: new Date() };
    entry.mailbox.enqueue(envelope);
    this.delivered++;
    this.publish(EventType.MessageDelivered, message);

    // Push notification is best-effort: the message is already safely in
    // the mailbox, so a throwing handler loses nothing.
    if (entry.handler) {
      try {
        const result = entry.handler(envelope);
        if (result instanceof Promise) {
          result.catch(() => {});
        }
      } catch {
        // isolated — pull consumption is unaffected
      }
    }

    return message;
  }

  /**
   * Send to every mailbox except the sender's: one message per recipient
   * (unique ids) sharing one correlationId. Zero recipients is fine.
   */
  broadcast(
    fromAgentId: string,
    messageType: string,
    payload?: unknown,
  ): AgentMessage[] {
    const correlationId = randomUUID();
    const messages: AgentMessage[] = [];

    for (const toAgentId of this.mailboxes.keys()) {
      if (toAgentId === fromAgentId) {
        continue;
      }

      messages.push(
        this.send({ fromAgentId, toAgentId, messageType, correlationId, payload }),
      );
    }

    return messages;
  }

  getDiagnostics(): MessageBusDiagnostics {
    const queueSizes: Record<string, number> = {};

    for (const [agentId, entry] of this.mailboxes) {
      queueSizes[agentId] = entry.mailbox.size();
    }

    return {
      totalSent: this.totalSent,
      delivered: this.delivered,
      undeliverable: this.undeliverable,
      activeMailboxes: this.mailboxes.size,
      queueSizes,
    };
  }

  private stamp(draft: MessageDraft): AgentMessage {
    const id = randomUUID();

    return {
      id,
      fromAgentId: draft.fromAgentId,
      toAgentId: draft.toAgentId,
      messageType: draft.messageType,
      correlationId: draft.correlationId ?? id,
      payload: draft.payload ?? null,
      createdAt: new Date(),
    };
  }

  private publish(
    type: EventType,
    message: AgentMessage,
    extra: Record<string, unknown> = {},
  ): void {
    this.eventBus?.publish({
      type,
      source: 'message-bus',
      correlationId: message.correlationId,
      payload: {
        messageId: message.id,
        fromAgentId: message.fromAgentId,
        toAgentId: message.toAgentId,
        messageType: message.messageType,
        ...extra,
      },
    });
  }
}
