import { AgentStatus } from '../agents/AgentStatus.ts';
import { TaskStatus } from '../delegation/TaskStatus.ts';
import { EventType } from '../events/EventType.ts';
import { LeastLoadedRoutingStrategy } from '../supervisor/LeastLoadedRoutingStrategy.ts';
import type { AgentRegistry } from '../agents/AgentRegistry.ts';
import type { DelegationManager } from '../delegation/DelegationManager.ts';
import type { EventBus } from '../events/EventBus.ts';
import type { EventEnvelope } from '../events/EventEnvelope.ts';
import type { Logger } from '../observability/index.ts';
import type { MetricsRegistry } from '../metrics/index.ts';
import type { Tracer } from '../tracing/index.ts';
import type { RoutingStrategy, WorkerCandidate } from '../supervisor/RoutingStrategy.ts';
import type { SupervisorResult } from '../supervisor/SupervisorResult.ts';
import type { WorkRequest } from '../supervisor/SupervisorAgent.ts';
import type { WorkerRegistry } from './WorkerRegistry.ts';

export interface DistributedSupervisorOptions {
  delegationManager: DelegationManager;
  eventBus: EventBus;
  workerRegistry: WorkerRegistry;
  agentRegistry: AgentRegistry;
  /** Default: least-loaded with alphabetical tie-breaking — the same
   *  strategy and default as SupervisorAgent, so load balancing behaves
   *  identically whether candidates are all local or spread across
   *  nodes: each candidate is one worker id regardless of which node
   *  hosts it, so least-loaded routing already balances across nodes. */
  routingStrategy?: RoutingStrategy;
  supervisorId?: string;
  /** How many times to re-delegate a failed task to a DIFFERENT worker
   *  before giving up. Default 0 (no retry, same behavior as
   *  SupervisorAgent). Overridable per call via submitWork()'s
   *  DistributedWorkRequest.maxRetries. */
  maxRetries?: number;
  logger?: Logger;
  tracer?: Tracer;
  metrics?: MetricsRegistry;
}

export interface DistributedWorkRequest extends WorkRequest {
  /** Only workers advertising this capability are eligible. Omit to
   *  route to any available worker, exactly like SupervisorAgent. */
  requiredCapability?: string;
  /** Overrides the instance-level default for this call. */
  maxRetries?: number;
}

export interface DistributedSupervisorDiagnostics {
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
  retried: number;
}

interface AttemptState {
  resolve: (result: SupervisorResult) => void;
  work: WorkRequest;
  requiredCapability: string | undefined;
  retriesLeft: number;
  excludedWorkers: Set<string>;
  workerId: string;
  attempt: number;
}

// The distributed-aware sibling of SupervisorAgent: same job (compose
// registry + delegation + events into "submit work, get a settled
// result"), but sourcing candidates from WorkerRegistry (local AND
// remote workers) instead of AgentRegistry directly, with two additions
// SupervisorAgent's fixed candidate-building can't express — a
// per-request required capability, and automatic retry on a DIFFERENT
// worker when a task fails. Deliberately a separate class rather than a
// SupervisorAgent subclass: SupervisorAgent.selectWorker() reads
// `this.agentRegistry.list()` directly with no seam for capability
// filtering or per-call context, so there is nothing to override — see
// core/distributed/index.ts for the fuller design note. SupervisorAgent
// itself is untouched and still the right choice for a purely
// in-process, non-distributed deployment.
//
// Failure DETECTION is not reimplemented here: HeartbeatWatchdog is the
// one place that decides "this worker is gone" and publishes
// EventType.AgentFailed, which AgentRegistry already reacts to (marks
// the worker Failed, so selectWorker() stops offering it). This class's
// own AgentFailed handler mirrors SupervisorAgent.onAgentFailed() only
// to turn that into the exact same DelegationManager.fail() call a live
// worker's own failure report would produce — so both "died mid-task"
// and "explicitly failed" flow through the ONE onSettled()/retry path
// below, reacting to EventType.TaskFailed either way.
export class DistributedSupervisor {
  private readonly delegationManager: DelegationManager;
  private readonly eventBus: EventBus;
  private readonly workerRegistry: WorkerRegistry;
  private readonly agentRegistry: AgentRegistry;
  private readonly routingStrategy: RoutingStrategy;
  private readonly supervisorId: string;
  private readonly defaultMaxRetries: number;
  private readonly logger: Logger | undefined;
  private readonly tracer: Tracer | undefined;
  private readonly metrics: MetricsRegistry | undefined;

  private readonly attempts = new Map<string, AttemptState>();
  private completed = 0;
  private failed = 0;
  private cancelled = 0;
  private retried = 0;

  constructor(options: DistributedSupervisorOptions) {
    this.delegationManager = options.delegationManager;
    this.eventBus = options.eventBus;
    this.workerRegistry = options.workerRegistry;
    this.agentRegistry = options.agentRegistry;
    this.routingStrategy = options.routingStrategy ?? new LeastLoadedRoutingStrategy();
    this.supervisorId = options.supervisorId ?? 'distributed-supervisor';
    this.defaultMaxRetries = options.maxRetries ?? 0;
    this.logger = options.logger;
    this.tracer = options.tracer;
    this.metrics = options.metrics;

    if (!this.agentRegistry.exists(this.supervisorId)) {
      this.agentRegistry.register({
        id: this.supervisorId,
        name: 'Distributed Supervisor',
        type: 'supervisor',
      });
    }

    this.eventBus.subscribe(EventType.TaskCompleted, (envelope) => {
      this.onSettled(envelope, 'completed');
    });
    this.eventBus.subscribe(EventType.TaskFailed, (envelope) => {
      this.onSettled(envelope, 'failed');
    });
    // The same reason SupervisorAgent subscribes to this: HeartbeatWatchdog
    // (or anything else) declaring a worker dead publishes AgentFailed,
    // not TaskFailed — without this, a task orphaned by a dead worker
    // would never settle its submitWork() promise. Reused, not
    // reimplemented: this only turns the event into the SAME
    // DelegationManager.fail() call SupervisorAgent makes, so the actual
    // failure — and therefore retry — flows through onSettled() above,
    // one path for every cause of failure.
    this.eventBus.subscribe(EventType.AgentFailed, (envelope) => {
      this.onAgentFailed(envelope);
    });
  }

  async submitWork(work: DistributedWorkRequest): Promise<SupervisorResult> {
    const { requiredCapability, maxRetries, ...draft } = work;
    const retries = maxRetries ?? this.defaultMaxRetries;

    return new Promise<SupervisorResult>((resolve) => {
      this.dispatch(draft, requiredCapability, retries, new Set(), resolve, 1);
    });
  }

  /** Pick a worker from WorkerRegistry's pool (capability-filtered when
   *  given), excluding any ids the caller has already tried. */
  selectWorker(
    requiredCapability?: string,
    excludedWorkers: ReadonlySet<string> = new Set(),
  ): string | null {
    const load = this.delegationManager.getDiagnostics().assignmentsPerAgent;
    const pool = requiredCapability
      ? this.workerRegistry.findByCapability(requiredCapability)
      : this.workerRegistry.list();

    const candidates: WorkerCandidate[] = pool
      .filter((worker) => !excludedWorkers.has(worker.id))
      .map((worker) => ({
        agentId: worker.id,
        available: this.isAvailable(worker.id),
        activeAssignments: load[worker.id] ?? 0,
      }));

    return this.routingStrategy.selectWorker(candidates);
  }

  getDiagnostics(): DistributedSupervisorDiagnostics {
    return {
      active: this.attempts.size,
      completed: this.completed,
      failed: this.failed,
      cancelled: this.cancelled,
      retried: this.retried,
    };
  }

  private isAvailable(workerId: string): boolean {
    if (!this.agentRegistry.exists(workerId)) {
      return false;
    }
    const state = this.agentRegistry.get(workerId).state;
    return state === AgentStatus.Active || state === AgentStatus.Completed;
  }

  private dispatch(
    work: WorkRequest,
    requiredCapability: string | undefined,
    retriesLeft: number,
    excludedWorkers: Set<string>,
    resolve: (result: SupervisorResult) => void,
    attempt: number,
  ): void {
    const workerId = this.selectWorker(requiredCapability, excludedWorkers);

    const task = this.delegationManager.createTask({
      ...work,
      assignedBy: this.supervisorId,
      metadata: { ...(work.metadata ?? {}), attempt },
    });

    if (!workerId) {
      const reason = requiredCapability
        ? `No available worker with capability "${requiredCapability}".`
        : 'No available worker.';
      this.delegationManager.cancel(task.id, reason);
      this.cancelled++;
      resolve({
        taskId: task.id,
        workerId: null,
        status: TaskStatus.Cancelled,
        result: null,
        failureReason: reason,
      });
      return;
    }

    try {
      this.tracer
        ? this.tracer.withSpan('distributed.dispatch', () =>
            this.delegationManager.assign(task.id, workerId),
          )
        : this.delegationManager.assign(task.id, workerId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.delegationManager.cancel(task.id, reason);
      this.cancelled++;
      resolve({
        taskId: task.id,
        workerId: null,
        status: TaskStatus.Cancelled,
        result: null,
        failureReason: reason,
      });
      return;
    }

    this.attempts.set(task.id, {
      resolve,
      work,
      requiredCapability,
      retriesLeft,
      excludedWorkers,
      workerId,
      attempt,
    });
    this.metrics?.gauge('distributed.supervisor.active_tasks').set(this.attempts.size);
    this.logger?.info('Task dispatched', { taskId: task.id, workerId, attempt });
  }

  private onSettled(envelope: EventEnvelope, outcome: 'completed' | 'failed'): void {
    const taskId = (envelope.payload as { taskId?: string } | null)?.taskId;
    if (!taskId) {
      return;
    }

    const state = this.attempts.get(taskId);
    if (!state) {
      return;
    }
    this.attempts.delete(taskId);
    this.metrics?.gauge('distributed.supervisor.active_tasks').set(this.attempts.size);

    if (outcome === 'failed' && state.retriesLeft > 0) {
      this.retried++;
      this.metrics?.counter('distributed.tasks.retried').inc();
      this.eventBus.publish({
        type: EventType.TaskRetried,
        source: this.supervisorId,
        correlationId: taskId,
        payload: { previousTaskId: taskId, workerId: state.workerId, attempt: state.attempt },
      });
      this.logger?.warn('Retrying task on a different worker', {
        previousTaskId: taskId,
        failedWorkerId: state.workerId,
        retriesLeft: state.retriesLeft - 1,
      });

      const excluded = new Set(state.excludedWorkers);
      excluded.add(state.workerId);
      this.dispatch(
        state.work,
        state.requiredCapability,
        state.retriesLeft - 1,
        excluded,
        state.resolve,
        state.attempt + 1,
      );
      return;
    }

    if (outcome === 'completed') {
      this.completed++;
    } else {
      this.failed++;
    }

    const task = this.delegationManager.getTask(taskId);
    state.resolve({
      taskId: task.id,
      workerId: task.assignedTo,
      status: task.status,
      result: task.result?.output ?? null,
      failureReason: task.result?.error ?? null,
    });
  }

  // Mirrors SupervisorAgent.onAgentFailed(): fail every active task on
  // the dead worker THROUGH DelegationManager.fail(), so the resulting
  // task.failed event settles (and, if retries remain, re-dispatches)
  // through the one normal onSettled() path — no duplicate resolution
  // logic for "died mid-task" vs. "explicitly failed".
  private onAgentFailed(envelope: EventEnvelope): void {
    if (!envelope.source.startsWith('agent:')) {
      return;
    }

    const workerId = envelope.source.slice('agent:'.length);

    for (const [taskId, state] of this.attempts) {
      if (state.workerId !== workerId) {
        continue;
      }

      const task = this.delegationManager.getTask(taskId);
      if (task.status === TaskStatus.Assigned || task.status === TaskStatus.InProgress) {
        this.delegationManager.fail(taskId, `Worker agent "${workerId}" failed.`);
      }
    }
  }
}
