import type { EventType } from './EventType.ts';

// What a publisher provides. The bus wraps this into an EventEnvelope
// (adding eventId and timestamp) before delivery.
export interface Event {
  type: EventType;
  /** Who published, e.g. "plugin-loader" or "agent:assistant". */
  source: string;
  /**
   * Ties related events together — for agent executions this is the
   * lifecycle id. Defaults to the event's own id when omitted.
   */
  correlationId?: string;
  payload?: unknown;
}
