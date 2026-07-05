import { randomUUID } from 'node:crypto';
import { AgentLifecycle } from './AgentLifecycle.ts';
import { AgentState } from './AgentState.ts';
import { EventType } from '../events/EventType.ts';
import type { EventBus } from '../events/EventBus.ts';

export interface LifecycleManagerOptions {
  /** When provided, every lifecycle transition publishes framework events. */
  eventBus?: EventBus;
  /** Event source label, e.g. "agent:assistant". */
  source?: string;
}

// Creates and tracks lifecycle instances — the diagnostics surface for
// "what executions happened, and what state is each in?". One manager
// per runtime keeps diagnostics scoped to their conversation. With an
// event bus attached, transitions become framework events correlated by
// lifecycle id.
export class LifecycleManager {
  private readonly lifecycles = new Map<string, AgentLifecycle>();
  private readonly eventBus: EventBus | undefined;
  private readonly source: string;

  constructor(options: LifecycleManagerOptions = {}) {
    this.eventBus = options.eventBus;
    this.source = options.source ?? 'lifecycle-manager';
  }

  create(): AgentLifecycle {
    const id = randomUUID();
    const lifecycle = new AgentLifecycle(id, (from, to, reason) =>
      this.publishTransition(id, from, to, reason),
    );

    this.lifecycles.set(id, lifecycle);

    this.eventBus?.publish({
      type: EventType.AgentCreated,
      source: this.source,
      correlationId: id,
      payload: { lifecycleId: id },
    });

    return lifecycle;
  }

  get(id: string): AgentLifecycle {
    const lifecycle = this.lifecycles.get(id);

    if (!lifecycle) {
      throw new Error(`Unknown lifecycle "${id}".`);
    }

    return lifecycle;
  }

  /** Every execution's lifecycle, in creation order. */
  list(): AgentLifecycle[] {
    return [...this.lifecycles.values()];
  }

  private publishTransition(
    lifecycleId: string,
    from: AgentState,
    to: AgentState,
    reason?: string,
  ): void {
    if (!this.eventBus) {
      return;
    }

    for (const type of mapTransitionToEvents(from, to)) {
      this.eventBus.publish({
        type,
        source: this.source,
        correlationId: lifecycleId,
        payload: {
          lifecycleId,
          from,
          to,
          ...(reason !== undefined ? { reason } : {}),
        },
      });
    }
  }
}

// From/to-aware mapping: the same target state means different things
// depending on where it was entered from — returning to Executing after
// a tool wait is a tool completion, not a fresh execution start. A
// failure during a tool wait is both a tool failure AND an agent failure.
function mapTransitionToEvents(from: AgentState, to: AgentState): EventType[] {
  switch (to) {
    case AgentState.Ready:
      return [EventType.AgentInitialized];
    case AgentState.Planning:
      return [EventType.PlanningStarted];
    case AgentState.Executing:
      return from === AgentState.WaitingForTool
        ? [EventType.ToolExecutionCompleted]
        : [EventType.ExecutionStarted];
    case AgentState.WaitingForTool:
      return [EventType.ToolExecutionStarted];
    case AgentState.Completed:
      return [EventType.AgentCompleted];
    case AgentState.Failed:
      return from === AgentState.WaitingForTool
        ? [EventType.ToolExecutionFailed, EventType.AgentFailed]
        : [EventType.AgentFailed];
    case AgentState.Cancelled:
      return [EventType.AgentCancelled];
    default:
      // Initializing and Disposed have no dedicated event types.
      return [];
  }
}
