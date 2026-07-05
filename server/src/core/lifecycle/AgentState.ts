// Every state an agent execution can be in. A const-object union instead
// of a TS enum: Node's type stripping cannot run enums.
export const AgentState = {
  Created: 'created',
  Initializing: 'initializing',
  Ready: 'ready',
  Planning: 'planning',
  Executing: 'executing',
  WaitingForTool: 'waiting-for-tool',
  WaitingForUser: 'waiting-for-user',
  Completed: 'completed',
  Cancelled: 'cancelled',
  Failed: 'failed',
  Disposed: 'disposed',
} as const;

export type AgentState = (typeof AgentState)[keyof typeof AgentState];
