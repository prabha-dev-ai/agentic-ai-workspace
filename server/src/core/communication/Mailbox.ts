import type { MessageEnvelope } from './MessageEnvelope.ts';

// A FIFO queue of delivered messages, one per registered agent. Plain
// and synchronous — async/distributed queues are explicitly out of scope.
export class Mailbox {
  private queue: MessageEnvelope[] = [];

  enqueue(envelope: MessageEnvelope): void {
    this.queue.push(envelope);
  }

  /** Remove and return the oldest message, or undefined when empty. */
  dequeue(): MessageEnvelope | undefined {
    return this.queue.shift();
  }

  /** Look at the oldest message without removing it. */
  peek(): MessageEnvelope | undefined {
    return this.queue[0];
  }

  size(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue = [];
  }
}
