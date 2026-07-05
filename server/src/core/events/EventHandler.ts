import type { EventEnvelope } from './EventEnvelope.ts';

// Handlers may be sync or async. Delivery itself is synchronous and
// ordered; an async handler's rejection is still caught and recorded in
// the bus diagnostics (see EventBus).
export type EventHandler = (event: EventEnvelope) => void | Promise<void>;
