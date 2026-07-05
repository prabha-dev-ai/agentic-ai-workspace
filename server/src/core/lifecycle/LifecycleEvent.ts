import type { AgentState } from './AgentState.ts';

// One record per transition — together they form the execution's history.
// Creation itself is the first event, with from: null.
export interface LifecycleEvent {
  from: AgentState | null;
  to: AgentState;
  at: Date;
  /** Why the transition happened (e.g. an error message for Failed). */
  reason?: string;
}
