import { randomUUID } from 'node:crypto';
import { DistributedError } from './DistributedError.ts';
import { EventType } from '../events/EventType.ts';
import { WORKER_REGISTRY_CHANNEL } from './DistributedProtocol.ts';
import type { WorkerRegistryWireMessage } from './DistributedProtocol.ts';
import type { AgentRegistry } from '../agents/AgentRegistry.ts';
import type { DistributedTransport } from './DistributedTransport.ts';
import type { EventBus } from '../events/EventBus.ts';
import type { Logger } from '../observability/index.ts';
import type { MetricsRegistry } from '../metrics/index.ts';
import type { WorkerDescriptor, WorkerRegistration } from './WorkerDescriptor.ts';

export interface WorkerRegistryOptions {
  eventBus: EventBus;
  transport: DistributedTransport;
  /** This process's node identity — stamped on every announcement. */
  nodeId: string;
  /** Registry agent type used for mirrored/local workers. Default
   *  "worker", matching SupervisorAgent's own default so routing needs
   *  no configuration to see distributed candidates. */
  workerType?: string;
  logger?: Logger;
  metrics?: MetricsRegistry;
}

export interface WorkerHandle {
  readonly id: string;
  unregister(): void;
}

export interface WorkerRegistryDiagnostics {
  total: number;
  local: number;
  remote: number;
  byNode: Record<string, number>;
}

// The distributed agent registry: a catalog of every worker the process
// knows about — hosted locally, or mirrored in from peer nodes over the
// DistributedTransport — plus the capability tags AgentDescriptor has no
// dedicated field for. Deliberately layered ON TOP of AgentRegistry
// (connectAgentRegistry(), called once from bootstrap after both are
// constructed — the same connect-after-construct idiom as
// CheckpointManager.connectEventBus(), used here specifically to avoid a
// AgentRegistry -> MessageBus -> WorkerRegistry -> AgentRegistry
// construction cycle) rather than replacing it: SupervisorAgent and
// DistributedSupervisor both keep reading AgentRegistry.list() for
// routing candidates, local or remote, completely unmodified.
export class WorkerRegistry {
  private readonly eventBus: EventBus;
  private readonly transport: DistributedTransport;
  private readonly nodeId: string;
  private readonly workerType: string;
  private readonly logger: Logger | undefined;
  private readonly metrics: MetricsRegistry | undefined;

  private agentRegistry: AgentRegistry | undefined;
  private readonly workers = new Map<string, WorkerDescriptor>();
  private readonly announceHandler: (message: unknown) => void;

  constructor(options: WorkerRegistryOptions) {
    this.eventBus = options.eventBus;
    this.transport = options.transport;
    this.nodeId = options.nodeId;
    this.workerType = options.workerType ?? 'worker';
    this.logger = options.logger;
    this.metrics = options.metrics;

    this.announceHandler = (raw) => this.onWireMessage(raw as WorkerRegistryWireMessage);
    this.transport.subscribe(WORKER_REGISTRY_CHANNEL, this.announceHandler);

    // Late joiners ask peers to replay their local workers — without
    // this, a node started after its peers announced would never learn
    // about them (the in-memory/Redis transport is fire-and-forget, not
    // a durable log).
    this.transport.publish(WORKER_REGISTRY_CHANNEL, {
      kind: 'discover',
      originNodeId: this.nodeId,
    } satisfies WorkerRegistryWireMessage);
  }

  /** Mirror remote-worker announcements into the shared AgentRegistry so
   *  SupervisorAgent/DistributedSupervisor route to them like any other
   *  registered agent. Deferred to after construction — see the class
   *  doc comment for why this can't be a constructor dependency. */
  connectAgentRegistry(agentRegistry: AgentRegistry): void {
    this.agentRegistry = agentRegistry;
  }

  /** Register a worker hosted on THIS node: adds it to the local
   *  AgentRegistry (when connected) and announces it to every peer. */
  registerLocalWorker(registration: WorkerRegistration): WorkerHandle {
    const id = registration.id ?? randomUUID();

    if (this.workers.has(id)) {
      throw new DistributedError(`Worker "${id}" is already registered.`);
    }

    const descriptor: WorkerDescriptor = {
      id,
      nodeId: this.nodeId,
      name: registration.name,
      capabilities: registration.capabilities ?? [],
      registeredAt: new Date(),
      lastHeartbeatAt: new Date(),
      metadata: registration.metadata ?? {},
    };

    this.workers.set(id, descriptor);
    this.mirrorIntoAgentRegistry(descriptor);
    this.announce(descriptor);

    this.eventBus.publish({
      type: EventType.WorkerRegistered,
      source: `worker:${id}`,
      payload: { workerId: id, nodeId: this.nodeId, capabilities: descriptor.capabilities },
    });
    this.metrics?.gauge('distributed.workers.total').set(this.workers.size);
    this.logger?.info('Worker registered', { workerId: id, nodeId: this.nodeId });

    return {
      id,
      unregister: () => this.unregisterWorker(id),
    };
  }

  unregisterWorker(id: string): void {
    const descriptor = this.workers.get(id);
    if (!descriptor) {
      throw new DistributedError(`Worker "${id}" is not registered.`);
    }

    this.workers.delete(id);

    if (descriptor.nodeId === this.nodeId) {
      this.transport.publish(WORKER_REGISTRY_CHANNEL, {
        kind: 'remove',
        originNodeId: this.nodeId,
        workerId: id,
      } satisfies WorkerRegistryWireMessage);

      if (this.agentRegistry?.exists(id)) {
        this.agentRegistry.unregister(id);
      }
    }

    this.metrics?.gauge('distributed.workers.total').set(this.workers.size);
  }

  /** Record a liveness signal for a worker, local or remote — called by
   *  WorkerHeartbeatSender (local) and this class's own wire handler
   *  (remote). Silently ignored for unknown ids: a heartbeat racing an
   *  unregister is not an error. */
  recordHeartbeat(id: string, at: Date = new Date()): void {
    const descriptor = this.workers.get(id);
    if (!descriptor) {
      return;
    }
    descriptor.lastHeartbeatAt = at;
  }

  /** Worker capability discovery: every currently-known worker that
   *  advertises the given capability, local or remote. */
  findByCapability(capability: string): WorkerDescriptor[] {
    return this.list().filter((worker) => worker.capabilities.includes(capability));
  }

  list(): WorkerDescriptor[] {
    return [...this.workers.values()];
  }

  get(id: string): WorkerDescriptor {
    const descriptor = this.workers.get(id);
    if (!descriptor) {
      throw new DistributedError(`Worker "${id}" is not registered.`);
    }
    return descriptor;
  }

  exists(id: string): boolean {
    return this.workers.has(id);
  }

  /** Where a known worker lives — the fact DistributedMessageBus needs to
   *  decide "deliver locally" vs. "forward over the wire". Undefined for
   *  an unknown id. */
  locate(id: string): { nodeId: string } | undefined {
    const descriptor = this.workers.get(id);
    return descriptor ? { nodeId: descriptor.nodeId } : undefined;
  }

  isLocal(id: string): boolean {
    return this.workers.get(id)?.nodeId === this.nodeId;
  }

  /** Workers whose last heartbeat is older than timeoutMs — what
   *  HeartbeatWatchdog sweeps for. */
  getStaleWorkers(timeoutMs: number, now: Date = new Date()): WorkerDescriptor[] {
    return this.list().filter(
      (worker) => now.getTime() - worker.lastHeartbeatAt.getTime() > timeoutMs,
    );
  }

  getDiagnostics(): WorkerRegistryDiagnostics {
    const byNode: Record<string, number> = {};
    let local = 0;

    for (const worker of this.workers.values()) {
      byNode[worker.nodeId] = (byNode[worker.nodeId] ?? 0) + 1;
      if (worker.nodeId === this.nodeId) {
        local++;
      }
    }

    return {
      total: this.workers.size,
      local,
      remote: this.workers.size - local,
      byNode,
    };
  }

  private announce(descriptor: WorkerDescriptor): void {
    this.transport.publish(WORKER_REGISTRY_CHANNEL, {
      kind: 'announce',
      originNodeId: this.nodeId,
      worker: descriptor,
    } satisfies WorkerRegistryWireMessage);
  }

  private mirrorIntoAgentRegistry(descriptor: WorkerDescriptor): void {
    if (!this.agentRegistry || this.agentRegistry.exists(descriptor.id)) {
      return;
    }

    this.agentRegistry.register({
      id: descriptor.id,
      name: descriptor.name,
      type: this.workerType,
      metadata: {
        ...descriptor.metadata,
        nodeId: descriptor.nodeId,
        capabilities: descriptor.capabilities,
        distributed: true,
      },
    });
  }

  private onWireMessage(message: WorkerRegistryWireMessage): void {
    if (message.originNodeId === this.nodeId) {
      return;
    }

    switch (message.kind) {
      case 'announce': {
        const descriptor: WorkerDescriptor = {
          ...message.worker,
          registeredAt: new Date(message.worker.registeredAt),
          lastHeartbeatAt: new Date(message.worker.lastHeartbeatAt),
        };
        this.workers.set(descriptor.id, descriptor);
        this.mirrorIntoAgentRegistry(descriptor);
        this.metrics?.gauge('distributed.workers.total').set(this.workers.size);
        this.logger?.info('Remote worker discovered', {
          workerId: descriptor.id,
          nodeId: descriptor.nodeId,
        });
        break;
      }
      case 'remove': {
        this.workers.delete(message.workerId);
        if (this.agentRegistry?.exists(message.workerId)) {
          this.agentRegistry.unregister(message.workerId);
        }
        this.metrics?.gauge('distributed.workers.total').set(this.workers.size);
        break;
      }
      case 'heartbeat': {
        this.recordHeartbeat(message.workerId, new Date(message.at));
        break;
      }
      case 'discover': {
        // Replay only OUR local workers — every node answers a discover
        // request with its own roster, never re-broadcasting what it
        // learned from someone else (that would echo forever).
        for (const worker of this.workers.values()) {
          if (worker.nodeId === this.nodeId) {
            this.announce(worker);
          }
        }
        break;
      }
    }
  }
}
