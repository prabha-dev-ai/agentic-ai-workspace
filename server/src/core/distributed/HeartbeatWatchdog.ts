import { EventType } from '../events/EventType.ts';
import type { EventBus } from '../events/EventBus.ts';
import type { Logger } from '../observability/index.ts';
import type { MetricsRegistry } from '../metrics/index.ts';
import type { WorkerRegistry } from './WorkerRegistry.ts';

export interface HeartbeatWatchdogOptions {
  workerRegistry: WorkerRegistry;
  eventBus: EventBus;
  /** A worker silent longer than this is considered lost. Default 15000ms. */
  timeoutMs?: number;
  /** How often to sweep for stale workers. Default 5000ms. */
  sweepIntervalMs?: number;
  logger?: Logger;
  metrics?: MetricsRegistry;
}

export interface HeartbeatWatchdogDiagnostics {
  sweeps: number;
  timeouts: number;
}

// The coordinator side of the heartbeat protocol: periodically sweeps
// WorkerRegistry for workers whose last heartbeat is older than the
// configured timeout and declares them lost.
//
// Deliberately reuses the EXISTING failover path rather than inventing a
// new one: a timed-out worker publishes EventType.AgentFailed with
// source "agent:<workerId>" — the exact envelope shape AgentRegistry
// already listens for (marks the agent Failed) and SupervisorAgent
// already listens for (fails every active task on that worker through
// DelegationManager.fail(), which settles any pending submitWork()
// promise). Retry, if configured, is DistributedSupervisor reacting to
// the resulting task.failed event — this class's only job is deciding
// "this worker is gone," not what happens next.
export class HeartbeatWatchdog {
  private readonly workerRegistry: WorkerRegistry;
  private readonly eventBus: EventBus;
  private readonly timeoutMs: number;
  private readonly sweepIntervalMs: number;
  private readonly logger: Logger | undefined;
  private readonly metrics: MetricsRegistry | undefined;
  private readonly declaredLost = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private sweeps = 0;
  private timeouts = 0;

  constructor(options: HeartbeatWatchdogOptions) {
    this.workerRegistry = options.workerRegistry;
    this.eventBus = options.eventBus;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 5000;
    this.logger = options.logger;
    this.metrics = options.metrics;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Run one sweep immediately — exposed for tests and for callers that
   *  want a deterministic check rather than waiting on the interval. */
  sweep(now: Date = new Date()): void {
    this.sweeps++;

    for (const worker of this.workerRegistry.getStaleWorkers(this.timeoutMs, now)) {
      if (this.declaredLost.has(worker.id)) {
        continue;
      }
      this.declaredLost.add(worker.id);
      this.timeouts++;

      this.eventBus.publish({
        type: EventType.WorkerLost,
        source: `worker-registry:${worker.nodeId}`,
        payload: {
          workerId: worker.id,
          nodeId: worker.nodeId,
          lastHeartbeatAt: worker.lastHeartbeatAt.toISOString(),
          timeoutMs: this.timeoutMs,
        },
      });

      // Reuse AgentRegistry/SupervisorAgent's existing failure handling —
      // see the class doc comment.
      this.eventBus.publish({
        type: EventType.AgentFailed,
        source: `agent:${worker.id}`,
        payload: { reason: `Heartbeat timeout after ${this.timeoutMs}ms.` },
      });

      this.metrics?.counter('distributed.heartbeat.timeouts').inc();
      this.logger?.warn('Worker heartbeat timed out', {
        workerId: worker.id,
        nodeId: worker.nodeId,
      });
    }

    // A worker that comes back (heartbeat resumes after a hiccup, or it
    // re-registers) is eligible to be declared lost again in the future.
    for (const id of [...this.declaredLost]) {
      if (!this.workerRegistry.exists(id) || this.workerRegistry.get(id).lastHeartbeatAt.getTime() + this.timeoutMs > now.getTime()) {
        this.declaredLost.delete(id);
      }
    }
  }

  getDiagnostics(): HeartbeatWatchdogDiagnostics {
    return { sweeps: this.sweeps, timeouts: this.timeouts };
  }
}
