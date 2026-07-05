import { AgentStatus } from '../agents/AgentStatus.ts';
import { TaskStatus } from '../delegation/TaskStatus.ts';
import { EventType } from '../events/EventType.ts';
import { LeastLoadedRoutingStrategy } from './LeastLoadedRoutingStrategy.ts';
import type { AgentRegistry } from '../agents/AgentRegistry.ts';
import type { DelegationManager } from '../delegation/DelegationManager.ts';
import type { Task, TaskDraft } from '../delegation/Task.ts';
import type { EventBus } from '../events/EventBus.ts';
import type { EventEnvelope } from '../events/EventEnvelope.ts';
import type { RoutingStrategy, WorkerCandidate } from './RoutingStrategy.ts';
import type { SupervisorResult } from './SupervisorResult.ts';

export interface SupervisorAgentOptions {
  agentRegistry: AgentRegistry;
  delegationManager: DelegationManager;
  eventBus: EventBus;
  /** Default: least-loaded with alphabetical tie-breaking. */
  routingStrategy?: RoutingStrategy;
  /** Registry id the supervisor acts under. Default: "supervisor". */
  supervisorId?: string;
  /** Which registry agent type counts as a worker. Default: "worker". */
  workerType?: string;
}

/** What callers submit; the supervisor owns delegation details. */
export type WorkRequest = Omit<TaskDraft, 'assignedBy'>;

export interface SupervisorDiagnostics {
  supervisedTasks: number;
  active: number;
  completed: number;
  failed: number;
  /** Active supervised tasks per worker. */
  workerUtilization: Record<string, number>;
}

interface SupervisedEntry {
  workerId: string;
  status: 'active' | 'completed' | 'failed';
}

// The orchestrator: composes registry (who can work), delegation (what
// work exists), and events (what happened) — owning none of their logic.
// Work is resolved reactively: submitWork() returns a promise that the
// task.completed / task.failed event handlers settle.
export class SupervisorAgent {
  private readonly agentRegistry: AgentRegistry;
  private readonly delegationManager: DelegationManager;
  private readonly routingStrategy: RoutingStrategy;
  private readonly supervisorId: string;
  private readonly workerType: string;

  private readonly supervised = new Map<string, SupervisedEntry>();
  private readonly pending = new Map<string, (result: SupervisorResult) => void>();

  constructor(options: SupervisorAgentOptions) {
    this.agentRegistry = options.agentRegistry;
    this.delegationManager = options.delegationManager;
    this.routingStrategy = options.routingStrategy ?? new LeastLoadedRoutingStrategy();
    this.supervisorId = options.supervisorId ?? 'supervisor';
    this.workerType = options.workerType ?? 'worker';

    // The supervisor is itself a registered agent — visible in the
    // registry, but never a routing candidate (wrong type).
    if (!this.agentRegistry.exists(this.supervisorId)) {
      this.agentRegistry.register({
        id: this.supervisorId,
        name: 'Supervisor',
        type: 'supervisor',
      });
    }

    options.eventBus.subscribe(EventType.TaskCompleted, (envelope) => {
      this.onTaskSettled(envelope, 'completed');
    });
    options.eventBus.subscribe(EventType.TaskFailed, (envelope) => {
      this.onTaskSettled(envelope, 'failed');
    });
    options.eventBus.subscribe(EventType.AgentFailed, (envelope) => {
      this.onAgentFailed(envelope);
    });
  }

  /**
   * Submit work and receive its terminal outcome. Resolves when the
   * worker completes or fails the task; resolves immediately (cancelled)
   * when no worker is available.
   */
  async submitWork(work: WorkRequest): Promise<SupervisorResult> {
    const task = this.delegationManager.createTask({
      ...work,
      assignedBy: this.supervisorId,
    });

    const workerId = this.selectWorker();

    if (!workerId) {
      const reason = `No available "${this.workerType}" agent.`;
      this.delegationManager.cancel(task.id, reason);
      return {
        taskId: task.id,
        workerId: null,
        status: TaskStatus.Cancelled,
        result: null,
        failureReason: reason,
      };
    }

    this.delegateTask(task.id, workerId);

    return new Promise<SupervisorResult>((resolve) => {
      this.pending.set(task.id, resolve);
    });
  }

  /** Pick a worker using registry availability + delegation load. */
  selectWorker(): string | null {
    const load = this.delegationManager.getDiagnostics().assignmentsPerAgent;

    const candidates: WorkerCandidate[] = this.agentRegistry
      .list()
      .filter((descriptor) => descriptor.type === this.workerType)
      .map((descriptor) => ({
        agentId: descriptor.id,
        // Completed agents finished their last run and can take more
        // work; failed/cancelled agents cannot.
        available:
          descriptor.state === AgentStatus.Active ||
          descriptor.state === AgentStatus.Completed,
        activeAssignments: load[descriptor.id] ?? 0,
      }));

    return this.routingStrategy.selectWorker(candidates);
  }

  /** Assign through the delegation manager and start tracking. */
  delegateTask(taskId: string, workerId: string): Task {
    const task = this.delegationManager.assign(taskId, workerId);
    this.trackTask(taskId, workerId);
    return task;
  }

  trackTask(taskId: string, workerId: string): void {
    this.supervised.set(taskId, { workerId, status: 'active' });
  }

  /** Fold a terminal task record into the caller-facing result shape. */
  aggregateResult(task: Task): SupervisorResult {
    return {
      taskId: task.id,
      workerId: task.assignedTo,
      status: task.status,
      result: task.result?.output ?? null,
      failureReason: task.result?.error ?? null,
    };
  }

  getDiagnostics(): SupervisorDiagnostics {
    const diagnostics: SupervisorDiagnostics = {
      supervisedTasks: this.supervised.size,
      active: 0,
      completed: 0,
      failed: 0,
      workerUtilization: {},
    };

    for (const entry of this.supervised.values()) {
      diagnostics[entry.status]++;

      if (entry.status === 'active') {
        diagnostics.workerUtilization[entry.workerId] =
          (diagnostics.workerUtilization[entry.workerId] ?? 0) + 1;
      }
    }

    return diagnostics;
  }

  // ---- Event handlers -------------------------------------------------

  private onTaskSettled(
    envelope: EventEnvelope,
    outcome: 'completed' | 'failed',
  ): void {
    const taskId = (envelope.payload as { taskId?: string } | null)?.taskId;

    if (!taskId) {
      return;
    }

    const entry = this.supervised.get(taskId);

    // Events for tasks we did not delegate are not ours to handle.
    if (!entry || entry.status !== 'active') {
      return;
    }

    entry.status = outcome;

    const resolve = this.pending.get(taskId);
    this.pending.delete(taskId);
    resolve?.(this.aggregateResult(this.delegationManager.getTask(taskId)));
  }

  private onAgentFailed(envelope: EventEnvelope): void {
    if (!envelope.source.startsWith('agent:')) {
      return;
    }

    const workerId = envelope.source.slice('agent:'.length);

    // Fail every active task on the dead worker THROUGH the delegation
    // manager: the resulting task.failed events settle the promises via
    // the one normal path — no duplicate resolution logic.
    for (const [taskId, entry] of this.supervised) {
      if (entry.workerId !== workerId || entry.status !== 'active') {
        continue;
      }

      const task = this.delegationManager.getTask(taskId);
      if (
        task.status === TaskStatus.Assigned ||
        task.status === TaskStatus.InProgress
      ) {
        this.delegationManager.fail(taskId, `Worker agent "${workerId}" failed.`);
      }
    }
  }
}
