import type {
  ConversationMemory,
  ConversationMessage,
} from './memory.types.ts';

// In-process short-term memory: lives exactly as long as its runtime.
// The array hides behind a closure and getHistory() returns a copy, so
// nothing outside can mutate history behind the memory's back.
export function createConversationMemory(): ConversationMemory {
  let history: ConversationMessage[] = [];

  return {
    append(message: ConversationMessage): void {
      history.push(message);
    },

    getHistory(): ConversationMessage[] {
      return [...history];
    },

    clear(): void {
      history = [];
    },
  };
}
