import type { MessageEnvelope } from './MessageEnvelope.ts';

// Optional push notification for a mailbox. The message is ALWAYS
// enqueued first — pull (dequeue) remains the source of truth, and a
// throwing handler never loses a message.
export type MessageHandler = (envelope: MessageEnvelope) => void | Promise<void>;
