import type { TaskStatus } from './TaskStatus.ts';

/** A task's terminal outcome: what came back, or why it didn't. */
export interface TaskResult {
  taskId: string;
  /** The terminal status this result belongs to. */
  status: TaskStatus;
  /** Completion output; null for failures and cancellations. */
  output: unknown;
  /** Failure or cancellation reason; null for completions. */
  error: string | null;
  finishedAt: Date;
}
