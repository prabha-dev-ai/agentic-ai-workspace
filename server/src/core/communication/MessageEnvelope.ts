import type { AgentMessage } from './AgentMessage.ts';

/** What lands in a mailbox: the message plus its delivery stamp. */
export interface MessageEnvelope {
  message: AgentMessage;
  deliveredAt: Date;
}
