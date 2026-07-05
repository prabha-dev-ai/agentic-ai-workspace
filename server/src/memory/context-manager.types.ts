import type { ConversationMessage } from './memory.types.ts';

// Context management contracts. Memory stores EVERYTHING; a context
// strategy decides what the model SEES on a given turn. Strategies are
// data (like agent definitions), so they can be configured per runtime.

export type ContextStrategy = 'full-history' | 'recent-only' | 'sliding-window';

/** The policy a runtime carries: which strategy, and how big a window. */
export interface ContextWindow {
  strategy: ContextStrategy;
  /** sliding-window only: max conversation messages included (default 10). */
  size?: number;
}

// The builder signature. context-manager.ts provides the standard one;
// future builders (token-budget, summarizing) must fit the same shape.
export type ContextBuilder = (
  history: ConversationMessage[],
  window: ContextWindow,
) => ConversationMessage[];
