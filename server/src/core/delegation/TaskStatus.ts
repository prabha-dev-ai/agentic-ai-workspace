// A task's coarse lifecycle. A const-object union instead of a TS enum:
// Node's type stripping cannot run enums.
export const TaskStatus = {
  Created: 'created',
  Assigned: 'assigned',
  InProgress: 'in-progress',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

// Same discipline as the agent lifecycle: transitions not in this table
// are bugs. A fast worker may complete straight from Assigned; cancel is
// allowed from any non-terminal state.
export const VALID_TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  [TaskStatus.Created]: [TaskStatus.Assigned, TaskStatus.Cancelled],
  [TaskStatus.Assigned]: [
    TaskStatus.InProgress,
    TaskStatus.Completed,
    TaskStatus.Failed,
    TaskStatus.Cancelled,
  ],
  [TaskStatus.InProgress]: [
    TaskStatus.Completed,
    TaskStatus.Failed,
    TaskStatus.Cancelled,
  ],
  [TaskStatus.Completed]: [],
  [TaskStatus.Failed]: [],
  [TaskStatus.Cancelled]: [],
};
