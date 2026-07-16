import { EventType } from '../events/EventType.ts';
import { WORKER_REGISTRY_CHANNEL } from './DistributedProtocol.ts';
import type { WorkerRegistryWireMessage } from './DistributedProtocol.ts';
import type { DistributedTransport } from './DistributedTransport.ts';
import type { EventBus } from '../events/EventBus.ts';
import type { Logger } from '../observability/index.ts';
import type { WorkerRegistry } from './WorkerRegistry.ts';

export interface WorkerHeartbeatSenderOptions {
  workerRegistry: WorkerRegistry;
  transport: DistributedTransport;
  eventBus: EventBus;
  nodeId: string;
  /** How often to announce liveness. Default 5000ms. */
  intervalMs?: number;
  logger?: Logger;
}

// The worker side of the heartbeat protocol: periodically announces
// "still alive" for every worker this node hosts, both updating the
// LOCAL WorkerRegistry bookkeeping (so a coordinator sharing the same
// process sees it too) and broadcasting over the transport so peer
// nodes' HeartbeatWatchdog never times this worker out.
export class WorkerHeartbeatSender {
  private readonly workerRegistry: WorkerRegistry;
  private readonly transport: DistributedTransport;
  private readonly eventBus: EventBus;
  private readonly nodeId: string;
  private readonly intervalMs: number;
  private readonly logger: Logger | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: WorkerHeartbeatSenderOptions) {
    this.workerRegistry = options.workerRegistry;
    this.transport = options.transport;
    this.eventBus = options.eventBus;
    this.nodeId = options.nodeId;
    this.intervalMs = options.intervalMs ?? 5000;
    this.logger = options.logger;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => this.beat(), this.intervalMs);
    this.timer.unref?.();
    this.beat();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Send one round of heartbeats immediately — exposed for tests and for
   *  callers that want an out-of-band beat right after registering. */
  beat(): void {
    const now = new Date();

    for (const worker of this.workerRegistry.list()) {
      if (worker.nodeId !== this.nodeId) {
        continue;
      }

      this.workerRegistry.recordHeartbeat(worker.id, now);
      this.transport.publish(WORKER_REGISTRY_CHANNEL, {
        kind: 'heartbeat',
        originNodeId: this.nodeId,
        workerId: worker.id,
        at: now.toISOString(),
      } satisfies WorkerRegistryWireMessage);

      this.eventBus.publish({
        type: EventType.WorkerHeartbeat,
        source: `worker:${worker.id}`,
        payload: { workerId: worker.id, nodeId: this.nodeId, at: now.toISOString() },
      });
    }

    this.logger?.debug('Heartbeat sent', { nodeId: this.nodeId });
  }
}
