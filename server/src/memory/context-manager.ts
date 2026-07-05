import type { ConversationMessage } from './memory.types.ts';
import type { ContextBuilder, ContextWindow } from './context-manager.types.ts';
import type { RetrievedDocument } from '../knowledge/knowledge.types.ts';

const DEFAULT_WINDOW_SIZE = 10;

// Pure function: history in, a NEW array out, order preserved, the
// original never modified. Memory owns storage; this owns presentation.
export const buildContext: ContextBuilder = (
  history: ConversationMessage[],
  window: ContextWindow,
): ConversationMessage[] => {
  switch (window.strategy) {
    case 'full-history':
      return [...history];

    // The latest user/assistant exchange only — for task-focused agents
    // where older turns are noise rather than context.
    case 'recent-only':
      return history.slice(-2);

    // Bounded recall: the last N messages. Memory appends turns in
    // user/assistant pairs, so an even size stays aligned to exchanges.
    case 'sliding-window':
      return history.slice(-(window.size ?? DEFAULT_WINDOW_SIZE));
  }
};

// Presentation for retrieved knowledge: documents in, one clearly labeled
// text block out — so the model can tell provided knowledge apart from
// the conversation. Returns null when nothing was retrieved, giving
// callers a clean "no knowledge this turn" branch.
export function formatRetrievedKnowledge(
  results: RetrievedDocument[],
): string | null {
  if (results.length === 0) {
    return null;
  }

  const documents = results
    .map(({ document }) => `[${document.title}]\n${document.content}`)
    .join('\n\n');

  return `Retrieved knowledge:\n\n${documents}`;
}
