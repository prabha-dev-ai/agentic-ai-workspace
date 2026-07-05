// Short-term conversation memory contracts. Deliberately narrower than
// the OpenAI message type: memory stores the DIALOGUE (user/assistant
// turns), not plumbing like tool calls — those are working state of a
// single reasoning cycle and would poison later turns if replayed.

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

// An interface so a persistent implementation (MongoDB later) can drop in
// without the runtime noticing.
export interface ConversationMemory {
  append(message: ConversationMessage): void;
  getHistory(): ConversationMessage[];
  clear(): void;
}
