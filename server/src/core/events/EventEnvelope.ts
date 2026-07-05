import type { EventType } from './EventType.ts';

// What subscribers receive: the published event plus the bus-stamped
// identity and time. Structurally satisfies the FrameworkEvent contract
// from the plugin capability model, so plugin subscribers consume
// envelopes directly.
export interface EventEnvelope {
  eventId: string;
  type: EventType;
  timestamp: Date;
  source: string;
  correlationId: string;
  payload: unknown;
}
