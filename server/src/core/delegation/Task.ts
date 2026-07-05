import type { TaskStatus } from './TaskStatus.ts';
import type { TaskResult } from './TaskResult.ts';

/** What a delegating agent provides. Identity and time are stamped. */
export interface TaskDraft {
  title: string;
  description: string;
  /** Registry id of the agent (or system) delegating the work. */
  assignedBy: string;
  payload?: unknown;
  metadata?: Record<string, unknown>;
  correlationId?: string;
}

/** The complete task record the DelegationManager tracks. */
export interface Task {
  id: string;
  title: string;
  description: string;
  assignedBy: string;
  /** Registry id of the assignee; null until assigned. */
  assignedTo: string | null;
  status: TaskStatus;
  payload: unknown;
  metadata: Record<string, unknown>;
  correlationId: string;
  createdAt: Date;
  /** Terminal outcome, present once completed/failed/cancelled. */
  result?: TaskResult;
}
