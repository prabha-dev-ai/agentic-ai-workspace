// Registry-level status — deliberately coarser than the 11-state
// execution lifecycle. The registry answers "how is this agent doing?",
// not "which micro-step is it on". A const-object union instead of a TS
// enum: Node's type stripping cannot run enums.
export const AgentStatus = {
  Active: 'active',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];
