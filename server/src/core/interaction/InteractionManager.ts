import { randomUUID } from 'node:crypto';
import { InteractionError } from './InteractionError.ts';
import { InteractionType } from './InteractionType.ts';
import { InteractionStatus, isTerminal } from './InteractionStatus.ts';
import type { Interaction } from './Interaction.ts';
import type { InteractionEvent } from './InteractionEvent.ts';
import type { UserResponse } from './UserResponse.ts';
import { AgentState } from '../lifecycle/AgentState.ts';
import type { AgentLifecycle } from '../lifecycle/AgentLifecycle.ts';
import { EventType } from '../events/EventType.ts';
import type { EventBus } from '../events/EventBus.ts';

export interface InteractionObserver {
  readonly name: string;
  onEvent(event: InteractionEvent): void;
}

export interface RequestOptions {
  /** Correlates this interaction with an agent execution's id. */
  agentId?: string;
  /** When provided, the agent pauses (Executing -> WaitingForUser) while
   *  this interaction is pending, and resumes when it resolves. */
  lifecycle?: AgentLifecycle;
  /** Free-form context for the human (e.g. the action being approved). */
  metadata?: Record<string, unknown>;
}

export interface InteractionManagerOptions {
  /** Interactions retained for getInteraction()/listInteractions(); oldest evicted first. Default 1000. */
  maxInteractions?: number;
}

export interface InteractionManagerDiagnostics {
  /** Every interaction ever created — a historical total, unaffected by retention eviction. */
  totalInteractions: number;
  pendingInteractions: number;
  resolvedInteractions: number;
  cancelledInteractions: number;
  timedOutInteractions: number;
  /** Registered observer names, in registration order. */
  observers: string[];
  /** Observer onEvent() throws — isolated, counted, never propagated. */
  observerFailures: number;
}

// The human-in-the-loop hub: components ask it to pause on an approval or
// an input request, a human resolves it (respond/cancel/timeout) from
// wherever that happens (an HTTP handler, a CLI prompt, a test), and
// whoever created the request is unblocked via the returned promise.
// When a request is tied to an AgentLifecycle, the manager drives the
// pause (Executing -> WaitingForUser) and resume (-> Executing) itself —
// this is what "Pause/Resume" means concretely, built on the framework's
// existing Agent Lifecycle rather than a parallel mechanism. Mirrors the
// other managers: fan-out-with-isolation observers, optional event bus
// bridge, bounded retention, running-counter diagnostics.
export class InteractionManager {
  private readonly interactions = new Map<string, Interaction>();
  private readonly interactionOrder: string[] = [];
  private readonly observers = new Map<string, InteractionObserver>();
  private readonly maxInteractions: number;
  private eventBus: EventBus | undefined;

  private totalInteractions = 0;
  private resolvedCount = 0;
  private cancelledCount = 0;
  private timedOutCount = 0;
  private observerFailures = 0;

  constructor(options: InteractionManagerOptions = {}) {
    this.maxInteractions = options.maxInteractions ?? 1000;
  }

  /** Register a global observer. Duplicate names fail loudly — silent
   *  replacement is how "where did my interaction events go?" bugs are born. */
  addObserver(observer: InteractionObserver): void {
    if (typeof observer.name !== 'string' || observer.name.trim() === '') {
      throw new InteractionError('An interaction observer needs a non-empty name.');
    }
    if (this.observers.has(observer.name)) {
      throw new InteractionError(
        `An interaction observer named "${observer.name}" is already registered.`,
      );
    }
    this.observers.set(observer.name, observer);
  }

  removeObserver(name: string): void {
    if (!this.observers.delete(name)) {
      throw new InteractionError(`No interaction observer named "${name}" is registered.`);
    }
  }

  /** Publish interaction lifecycle events onto the framework event bus,
   *  correlated by interaction id. */
  connectEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  /** Request a yes/no decision from a human. */
  requestApproval(prompt: string, options: RequestOptions = {}): Interaction {
    return this.createInteraction(InteractionType.Approval, prompt, options);
  }

  /** Request a free-form value from a human. */
  requestInput(prompt: string, options: RequestOptions = {}): Interaction {
    return this.createInteraction(InteractionType.Input, prompt, options);
  }

  getInteraction(id: string): Interaction | undefined {
    return this.interactions.get(id);
  }

  /** Every currently-retained interaction, oldest first. Subject to maxInteractions eviction. */
  listInteractions(): Interaction[] {
    return this.interactionOrder.map((id) => this.interactions.get(id)!);
  }

  /** Currently-retained interactions still awaiting a human. */
  listPending(): Interaction[] {
    return this.listInteractions().filter(
      (interaction) => interaction.status === InteractionStatus.Pending,
    );
  }

  getDiagnostics(): InteractionManagerDiagnostics {
    return {
      totalInteractions: this.totalInteractions,
      pendingInteractions:
        this.totalInteractions - this.resolvedCount - this.cancelledCount - this.timedOutCount,
      resolvedInteractions: this.resolvedCount,
      cancelledInteractions: this.cancelledCount,
      timedOutInteractions: this.timedOutCount,
      observers: [...this.observers.keys()],
      observerFailures: this.observerFailures,
    };
  }

  private createInteraction(
    type: InteractionType,
    prompt: string,
    options: RequestOptions,
  ): Interaction {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new InteractionError('An interaction needs a non-empty prompt.');
    }

    const id = randomUUID();
    const createdAt = new Date();
    const manager = this;
    const { agentId, lifecycle, metadata } = options;

    let status: InteractionStatus = InteractionStatus.Pending;
    let resolvedAt: Date | undefined;
    let response: UserResponse | undefined;
    let settleWait!: (response: UserResponse | undefined) => void;
    const waitPromise = new Promise<UserResponse | undefined>((resolve) => {
      settleWait = resolve;
    });

    const ensurePending = () => {
      if (isTerminal(status)) {
        throw new InteractionError(`Interaction "${id}" is already ${status} and cannot be modified.`);
      }
    };

    const resolveTo = (
      newStatus: InteractionStatus,
      resolvedResponse: UserResponse | undefined,
      event: InteractionEvent,
    ) => {
      ensurePending();
      status = newStatus;
      resolvedAt = new Date();
      response = resolvedResponse;

      manager.recordResolution(newStatus);
      manager.resumeLifecycle(lifecycle);
      manager.dispatch(event);
      settleWait(resolvedResponse);
    };

    const interaction: Interaction = {
      id,
      agentId,
      type,
      prompt,
      metadata,
      get status() {
        return status;
      },
      createdAt,
      get resolvedAt() {
        return resolvedAt;
      },
      get response() {
        return response;
      },

      respond(userResponse) {
        resolveTo(InteractionStatus.Resolved, userResponse, {
          type: 'resolved',
          interactionId: id,
          response: userResponse,
          timestamp: new Date(),
        });
      },

      cancel() {
        resolveTo(InteractionStatus.Cancelled, undefined, {
          type: 'cancelled',
          interactionId: id,
          timestamp: new Date(),
        });
      },

      timeout() {
        resolveTo(InteractionStatus.TimedOut, undefined, {
          type: 'timedout',
          interactionId: id,
          timestamp: new Date(),
        });
      },

      wait() {
        return waitPromise;
      },
    };

    this.totalInteractions++;
    this.retain(id, interaction);
    this.pauseLifecycle(lifecycle);
    this.dispatch({
      type: 'requested',
      interactionId: id,
      agentId,
      interactionType: type,
      prompt,
      timestamp: new Date(),
    });

    return interaction;
  }

  private pauseLifecycle(lifecycle: AgentLifecycle | undefined): void {
    if (lifecycle && lifecycle.getState() === AgentState.Executing) {
      lifecycle.transition(AgentState.WaitingForUser, 'awaiting human interaction');
    }
  }

  private resumeLifecycle(lifecycle: AgentLifecycle | undefined): void {
    if (lifecycle && lifecycle.getState() === AgentState.WaitingForUser) {
      lifecycle.transition(AgentState.Executing, 'human interaction resolved');
    }
  }

  private retain(id: string, interaction: Interaction): void {
    this.interactions.set(id, interaction);
    this.interactionOrder.push(id);

    if (this.interactionOrder.length > this.maxInteractions) {
      const evicted = this.interactionOrder.shift();
      if (evicted !== undefined) {
        this.interactions.delete(evicted);
      }
    }
  }

  private recordResolution(status: InteractionStatus): void {
    if (status === InteractionStatus.Resolved) this.resolvedCount++;
    else if (status === InteractionStatus.Cancelled) this.cancelledCount++;
    else if (status === InteractionStatus.TimedOut) this.timedOutCount++;
  }

  private dispatch(event: InteractionEvent): void {
    for (const observer of this.observers.values()) {
      try {
        observer.onEvent(event);
      } catch {
        this.observerFailures++;
      }
    }

    this.publishToEventBus(event);
  }

  private publishToEventBus(event: InteractionEvent): void {
    if (!this.eventBus) {
      return;
    }

    const type = EVENT_TYPE_BY_INTERACTION_EVENT[event.type];
    this.eventBus.publish({
      type,
      source: 'interaction-manager',
      correlationId: event.interactionId,
      payload: event,
    });
  }
}

const EVENT_TYPE_BY_INTERACTION_EVENT: Record<InteractionEvent['type'], EventType> = {
  requested: EventType.InteractionRequested,
  resolved: EventType.InteractionResolved,
  cancelled: EventType.InteractionCancelled,
  timedout: EventType.InteractionTimedOut,
};
