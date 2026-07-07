// A run's lifecycle: created and executing steps (Running), then exactly
// one terminal outcome. A const-object union instead of a TS enum —
// Node's type stripping cannot run enums (same pattern as StreamState,
// InteractionStatus).
export const WorkflowStatus = {
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
} as const;

export type WorkflowStatus = (typeof WorkflowStatus)[keyof typeof WorkflowStatus];
