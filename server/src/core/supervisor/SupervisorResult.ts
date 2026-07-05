import type { TaskStatus } from '../delegation/TaskStatus.ts';

/** The supervisor's answer for one piece of submitted work. */
export interface SupervisorResult {
  taskId: string;
  /** The worker that handled it, or null if none was available. */
  workerId: string | null;
  /** Terminal task status: completed, failed, or cancelled. */
  status: TaskStatus;
  /** The worker's output; null unless completed. */
  result: unknown;
  /** Why it did not complete; null when it did. */
  failureReason: string | null;
}
