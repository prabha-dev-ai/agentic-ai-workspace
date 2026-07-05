import type { AgentStatus } from './AgentStatus.ts';

// The registry's record of one agent: identity, category, and the
// current registry-level state (updated via event bus subscriptions,
// never by direct calls).
export interface AgentDescriptor {
  id: string;
  name: string;
  /** Free-form category, e.g. "conversational", "planner", "worker". */
  type: string;
  createdAt: Date;
  state: AgentStatus;
  metadata: Record<string, unknown>;
}
