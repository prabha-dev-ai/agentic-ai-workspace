// Addressed agent-to-agent communication. Distinct from framework events
// on purpose: events are broadcast facts ("something happened"); messages
// are directed communication with queuing semantics.

/** What a sender provides. The bus stamps identity and time. */
export interface MessageDraft {
  fromAgentId: string;
  toAgentId: string;
  /** Free-form protocol tag, e.g. "request", "response", "notification". */
  messageType: string;
  /** Ties a conversation of messages together. Defaults to the message id. */
  correlationId?: string;
  payload?: unknown;
}

/** The complete, stamped message record. */
export interface AgentMessage {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  messageType: string;
  correlationId: string;
  payload: unknown;
  createdAt: Date;
}
