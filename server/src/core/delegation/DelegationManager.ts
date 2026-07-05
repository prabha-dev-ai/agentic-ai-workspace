import { randomUUID } from 'node:crypto';
import { TaskStatus, VALID_TASK_TRANSITIONS } from './TaskStatus.ts';
import { EventType } from '../events/EventType.ts';
import type { Task, TaskDraft } from './Task.ts';
import type { TaskAssignment } from './TaskAssignment.ts';
import type { AgentRegistry } from '../agents/AgentRegistry.ts';
import type { EventBus } from '../events/EventBus.ts';
import type { MessageBus } from '../communication/MessageBus.ts';

export interface DelegationManagerOptions {
  /** When provided, assignees are validated against the registry. */
  agentRegistry?: AgentRegistry;
  /** When provided, assignments are delivered as structured messages. */
  messageBus?: MessageBus;
  /** When provided, every task transition publishes framework events. */
  eventBus?: EventBus;
}

export interface DelegationDiagnostics {
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
  /** Non-terminal task counts per assignee. */
  assignmentsPerAgent: Record<string, number>;
}

export interface TaskFilter {
  status?: TaskStatus;
  assignedTo?: string;
}

const STATUS_EVENTS: Partial<Record<TaskStatus, EventType>> = {
  [TaskStatus.Assigned]: EventType.TaskAssigned,
  [TaskStatus.InProgress]: EventType.TaskStarted,
  [TaskStatus.Completed]: EventType.TaskCompleted,
  [TaskStatus.Failed]: EventType.TaskFailed,
  [TaskStatus.Cancelled]: EventType.TaskCancelled,
};

// Structured work delegation. The manager owns task records and their
// state machine; the registry validates assignees; the message bus
// carries assignments to worker mailboxes; the event bus makes every
// step observable.
export class DelegationManager {
  private readonly tasks = new Map<string, Task>();
  private readonly agentRegistry: AgentRegistry | undefined;
  private readonly messageBus: MessageBus | undefined;
  private readonly eventBus: EventBus | undefined;

  constructor(options: DelegationManagerOptions = {}) {
    this.agentRegistry = options.agentRegistry;
    this.messageBus = options.messageBus;
    this.eventBus = options.eventBus;
  }

  createTask(draft: TaskDraft): Task {
    if (draft.title.trim() === '') {
      throw new Error('A task needs a non-empty title.');
    }

    if (draft.assignedBy.trim() === '') {
      throw new Error('A task needs a non-empty assignedBy.');
    }

    const id = randomUUID();
    const task: Task = {
      id,
      title: draft.title,
      description: draft.description,
      assignedBy: draft.assignedBy,
      assignedTo: null,
      status: TaskStatus.Created,
      payload: draft.payload ?? null,
      metadata: draft.metadata ?? {},
      correlationId: draft.correlationId ?? id,
      createdAt: new Date(),
    };

    this.tasks.set(id, task);
    this.publish(EventType.TaskCreated, task);

    return task;
  }

  /**
   * Assign a task to a registered agent. The assignment travels as a
   * structured message; if delivery fails, the assignment rolls back —
   * a task must never claim an assignee that never heard about it.
   */
  assign(taskId: string, agentId: string): Task {
    const task = this.getTask(taskId);

    this.ensureTransition(task, TaskStatus.Assigned);

    if (this.agentRegistry && !this.agentRegistry.exists(agentId)) {
      throw new Error(
        `Cannot assign task "${taskId}": agent "${agentId}" is not registered.`,
      );
    }

    task.assignedTo = agentId;
    task.status = TaskStatus.Assigned;

    if (this.messageBus) {
      const assignment: TaskAssignment = {
        taskId: task.id,
        title: task.title,
        description: task.description,
        assignedBy: task.assignedBy,
        payload: task.payload,
        correlationId: task.correlationId,
      };

      try {
        this.messageBus.send({
          fromAgentId: task.assignedBy,
          toAgentId: agentId,
          messageType: 'task.assignment',
          correlationId: task.correlationId,
          payload: assignment,
        });
      } catch (error) {
        task.assignedTo = null;
        task.status = TaskStatus.Created;
        throw error;
      }
    }

    this.publish(EventType.TaskAssigned, task);

    return task;
  }

  /** Generic guarded transition, e.g. to InProgress when work starts. */
  updateStatus(taskId: string, status: TaskStatus): Task {
    const task = this.getTask(taskId);

    this.ensureTransition(task, status);
    task.status = status;

    const event = STATUS_EVENTS[status];
    if (event) {
      this.publish(event, task);
    }

    return task;
  }

  complete(taskId: string, output: unknown = null): Task {
    const task = this.getTask(taskId);

    this.ensureTransition(task, TaskStatus.Completed);
    task.status = TaskStatus.Completed;
    task.result = {
      taskId: task.id,
      status: TaskStatus.Completed,
      output,
      error: null,
      finishedAt: new Date(),
    };

    this.publish(EventType.TaskCompleted, task);

    return task;
  }

  fail(taskId: string, error: string): Task {
    const task = this.getTask(taskId);

    this.ensureTransition(task, TaskStatus.Failed);
    task.status = TaskStatus.Failed;
    task.result = {
      taskId: task.id,
      status: TaskStatus.Failed,
      output: null,
      error,
      finishedAt: new Date(),
    };

    this.publish(EventType.TaskFailed, task, { error });

    return task;
  }

  cancel(taskId: string, reason = 'cancelled'): Task {
    const task = this.getTask(taskId);

    this.ensureTransition(task, TaskStatus.Cancelled);
    task.status = TaskStatus.Cancelled;
    task.result = {
      taskId: task.id,
      status: TaskStatus.Cancelled,
      output: null,
      error: reason,
      finishedAt: new Date(),
    };

    this.publish(EventType.TaskCancelled, task, { reason });

    return task;
  }

  getTask(taskId: string): Task {
    const task = this.tasks.get(taskId);

    if (!task) {
      throw new Error(`Unknown task "${taskId}".`);
    }

    return task;
  }

  listTasks(filter: TaskFilter = {}): Task[] {
    return [...this.tasks.values()].filter(
      (task) =>
        (filter.status === undefined || task.status === filter.status) &&
        (filter.assignedTo === undefined || task.assignedTo === filter.assignedTo),
    );
  }

  getDiagnostics(): DelegationDiagnostics {
    const diagnostics: DelegationDiagnostics = {
      active: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      total: this.tasks.size,
      assignmentsPerAgent: {},
    };

    for (const task of this.tasks.values()) {
      switch (task.status) {
        case TaskStatus.Completed:
          diagnostics.completed++;
          break;
        case TaskStatus.Failed:
          diagnostics.failed++;
          break;
        case TaskStatus.Cancelled:
          diagnostics.cancelled++;
          break;
        default: {
          diagnostics.active++;
          if (task.assignedTo) {
            diagnostics.assignmentsPerAgent[task.assignedTo] =
              (diagnostics.assignmentsPerAgent[task.assignedTo] ?? 0) + 1;
          }
        }
      }
    }

    return diagnostics;
  }

  private ensureTransition(task: Task, to: TaskStatus): void {
    if (!VALID_TASK_TRANSITIONS[task.status].includes(to)) {
      throw new Error(
        `Invalid task transition "${task.status}" -> "${to}" for task "${task.id}". ` +
          `Valid targets: ${VALID_TASK_TRANSITIONS[task.status].join(', ') || '(none)'}.`,
      );
    }
  }

  private publish(
    type: EventType,
    task: Task,
    extra: Record<string, unknown> = {},
  ): void {
    this.eventBus?.publish({
      type,
      source: 'delegation-manager',
      correlationId: task.correlationId,
      payload: {
        taskId: task.id,
        title: task.title,
        status: task.status,
        assignedBy: task.assignedBy,
        assignedTo: task.assignedTo,
        ...extra,
      },
    });
  }
}
