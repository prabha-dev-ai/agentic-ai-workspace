import { randomUUID } from 'node:crypto';
import { AgentStatus } from './AgentStatus.ts';
import { EventType } from '../events/EventType.ts';
import type { AgentDescriptor } from './AgentDescriptor.ts';
import type { AgentHandle } from './AgentHandle.ts';
import type { EventBus } from '../events/EventBus.ts';
import type { EventEnvelope } from '../events/EventEnvelope.ts';

/** What callers provide; id and timestamps are the registry's job. */
export interface AgentRegistration {
  /** Optional explicit id — generated when omitted. */
  id?: string;
  name: string;
  type: string;
  metadata?: Record<string, unknown>;
}

export interface AgentRegistryDiagnostics {
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
}

// Which registry state each lifecycle event implies. Anything not listed
// (plugin events, etc.) does not concern the registry.
const EVENT_STATUS: Partial<Record<string, AgentStatus>> = {
  [EventType.AgentCreated]: AgentStatus.Active,
  [EventType.AgentInitialized]: AgentStatus.Active,
  [EventType.PlanningStarted]: AgentStatus.Active,
  [EventType.ExecutionStarted]: AgentStatus.Active,
  [EventType.ToolExecutionStarted]: AgentStatus.Active,
  [EventType.ToolExecutionCompleted]: AgentStatus.Active,
  [EventType.AgentCompleted]: AgentStatus.Completed,
  [EventType.AgentFailed]: AgentStatus.Failed,
  [EventType.AgentCancelled]: AgentStatus.Cancelled,
};

// The catalog of every agent the framework knows about. State updates
// arrive EXCLUSIVELY through event bus subscriptions — runtimes publish
// lifecycle events with an "agent:<registryId>" source, and the registry
// listens; nothing calls the registry to report state directly.
export class AgentRegistry {
  private readonly agents = new Map<string, AgentDescriptor>();

  constructor(eventBus?: EventBus) {
    eventBus?.subscribe('*', (envelope) => {
      this.applyEvent(envelope);
    });
  }

  register(registration: AgentRegistration): AgentHandle {
    const id = registration.id ?? randomUUID();

    if (id.trim() === '') {
      throw new Error('An agent registration needs a non-empty id.');
    }

    if (registration.name.trim() === '') {
      throw new Error('An agent registration needs a non-empty name.');
    }

    // Two agents under one id means state updates hit the wrong agent —
    // fail loudly.
    if (this.agents.has(id)) {
      throw new Error(`Agent "${id}" is already registered.`);
    }

    const descriptor: AgentDescriptor = {
      id,
      name: registration.name,
      type: registration.type,
      createdAt: new Date(),
      state: AgentStatus.Active,
      metadata: registration.metadata ?? {},
    };

    this.agents.set(id, descriptor);

    return {
      id,
      getDescriptor: () => this.get(id),
      unregister: () => this.unregister(id),
    };
  }

  unregister(id: string): void {
    if (!this.agents.delete(id)) {
      throw new Error(`Agent "${id}" is not registered.`);
    }
  }

  get(id: string): AgentDescriptor {
    const descriptor = this.agents.get(id);

    if (!descriptor) {
      throw new Error(`Agent "${id}" is not registered.`);
    }

    return descriptor;
  }

  exists(id: string): boolean {
    return this.agents.has(id);
  }

  list(): AgentDescriptor[] {
    return [...this.agents.values()];
  }

  listByState(state: AgentStatus): AgentDescriptor[] {
    return this.list().filter((descriptor) => descriptor.state === state);
  }

  getDiagnostics(): AgentRegistryDiagnostics {
    const counts = {
      active: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const descriptor of this.agents.values()) {
      counts[descriptor.state]++;
    }

    return { ...counts, total: this.agents.size };
  }

  // Lifecycle events carry their agent in the source label
  // ("agent:<registryId>"). Unknown agents and non-agent sources are not
  // errors — the bus carries traffic that simply isn't for us.
  private applyEvent(envelope: EventEnvelope): void {
    if (!envelope.source.startsWith('agent:')) {
      return;
    }

    const agentId = envelope.source.slice('agent:'.length);
    const descriptor = this.agents.get(agentId);
    const nextState = EVENT_STATUS[envelope.type];

    if (descriptor && nextState) {
      descriptor.state = nextState;
    }
  }
}
