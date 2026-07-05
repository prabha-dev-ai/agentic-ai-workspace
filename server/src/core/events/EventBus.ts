import { randomUUID } from 'node:crypto';
import type { Event } from './Event.ts';
import type { EventEnvelope } from './EventEnvelope.ts';
import type { EventHandler } from './EventHandler.ts';
import type { EventType } from './EventType.ts';

/** Subscribe to one event type, or to everything with the wildcard. */
export type EventSubscriptionType = EventType | '*';

export interface HandlerFailure {
  eventId: string;
  eventType: string;
  error: string;
  at: Date;
}

export interface EventBusDiagnostics {
  publishedEvents: number;
  /** Active handler counts per subscription type (empty buckets omitted). */
  subscribers: Record<string, number>;
  handlerFailures: HandlerFailure[];
}

// The framework's internal event bus: ordered synchronous delivery with
// handler isolation. Publishers never know who is listening; a broken
// subscriber is recorded in diagnostics and never breaks the publisher
// or the other subscribers.
export class EventBus {
  private readonly handlers = new Map<EventSubscriptionType, Set<EventHandler>>();
  private publishedEvents = 0;
  private readonly failures: HandlerFailure[] = [];

  subscribe(type: EventSubscriptionType, handler: EventHandler): void {
    let bucket = this.handlers.get(type);

    if (!bucket) {
      bucket = new Set();
      this.handlers.set(type, bucket);
    }

    bucket.add(handler);
  }

  unsubscribe(type: EventSubscriptionType, handler: EventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  /**
   * Deliver synchronously and in order: exact-type handlers first (in
   * subscription order), then wildcard handlers. Returns the envelope
   * that was delivered.
   */
  publish(event: Event): EventEnvelope {
    const eventId = randomUUID();
    const envelope: EventEnvelope = {
      eventId,
      type: event.type,
      timestamp: new Date(),
      source: event.source,
      correlationId: event.correlationId ?? eventId,
      payload: event.payload ?? null,
    };

    this.publishedEvents++;

    const targets = [
      ...(this.handlers.get(event.type) ?? []),
      ...(this.handlers.get('*') ?? []),
    ];

    for (const handler of targets) {
      // Handler isolation: one subscriber's failure must never break the
      // publisher or the remaining subscribers.
      try {
        const result = handler(envelope);

        if (result instanceof Promise) {
          result.catch((error: unknown) => this.recordFailure(envelope, error));
        }
      } catch (error) {
        this.recordFailure(envelope, error);
      }
    }

    return envelope;
  }

  getDiagnostics(): EventBusDiagnostics {
    const subscribers: Record<string, number> = {};

    for (const [type, bucket] of this.handlers) {
      if (bucket.size > 0) {
        subscribers[type] = bucket.size;
      }
    }

    return {
      publishedEvents: this.publishedEvents,
      subscribers,
      handlerFailures: [...this.failures],
    };
  }

  private recordFailure(envelope: EventEnvelope, error: unknown): void {
    this.failures.push({
      eventId: envelope.eventId,
      eventType: envelope.type,
      error: error instanceof Error ? error.message : String(error),
      at: new Date(),
    });
  }
}
