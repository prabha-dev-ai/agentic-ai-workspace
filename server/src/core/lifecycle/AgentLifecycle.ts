import { AgentState } from './AgentState.ts';
import type { LifecycleEvent } from './LifecycleEvent.ts';

// The agent execution state machine. Transitions not in this table are
// bugs, and rejecting them loudly is the point of having a lifecycle:
// an execution can never silently jump from Completed back to Executing.
const VALID_TRANSITIONS: Record<AgentState, readonly AgentState[]> = {
  [AgentState.Created]: [AgentState.Initializing, AgentState.Cancelled, AgentState.Disposed],
  [AgentState.Initializing]: [AgentState.Ready, AgentState.Failed, AgentState.Cancelled],
  [AgentState.Ready]: [AgentState.Planning, AgentState.Executing, AgentState.Cancelled, AgentState.Disposed],
  [AgentState.Planning]: [AgentState.Executing, AgentState.Completed, AgentState.Failed, AgentState.Cancelled],
  [AgentState.Executing]: [AgentState.WaitingForTool, AgentState.WaitingForUser, AgentState.Completed, AgentState.Failed, AgentState.Cancelled],
  [AgentState.WaitingForTool]: [AgentState.Executing, AgentState.Failed, AgentState.Cancelled],
  [AgentState.WaitingForUser]: [AgentState.Executing, AgentState.Failed, AgentState.Cancelled],
  [AgentState.Completed]: [AgentState.Disposed],
  [AgentState.Cancelled]: [AgentState.Disposed],
  [AgentState.Failed]: [AgentState.Disposed],
  [AgentState.Disposed]: [],
};

// Work has ended in these states; duration freezes here. Disposed is
// cleanup after the fact, not more work.
const TERMINAL_STATES: readonly AgentState[] = [
  AgentState.Completed,
  AgentState.Cancelled,
  AgentState.Failed,
  AgentState.Disposed,
];

export class InvalidLifecycleTransitionError extends Error {
  readonly from: AgentState;
  readonly to: AgentState;

  constructor(from: AgentState, to: AgentState) {
    super(
      `Invalid lifecycle transition "${from}" -> "${to}". ` +
        `Valid targets from "${from}": ${VALID_TRANSITIONS[from].join(', ') || '(none)'}.`,
    );
    this.name = new.target.name;
    this.from = from;
    this.to = to;
  }
}

/** Notified after every successful transition (used to publish events). */
export type TransitionObserver = (
  from: AgentState,
  to: AgentState,
  reason?: string,
) => void;

// One agent execution's lifecycle: current state, validated transitions,
// and a complete, timestamped history.
export class AgentLifecycle {
  readonly id: string;
  private state: AgentState = AgentState.Created;
  private readonly history: LifecycleEvent[] = [];
  private readonly onTransition: TransitionObserver | undefined;

  constructor(id: string, onTransition?: TransitionObserver) {
    this.id = id;
    this.onTransition = onTransition;
    this.history.push({ from: null, to: AgentState.Created, at: new Date() });
  }

  getState(): AgentState {
    return this.state;
  }

  transition(to: AgentState, reason?: string): void {
    if (!VALID_TRANSITIONS[this.state].includes(to)) {
      throw new InvalidLifecycleTransitionError(this.state, to);
    }

    const from = this.state;

    this.history.push({
      from,
      to,
      at: new Date(),
      ...(reason !== undefined ? { reason } : {}),
    });
    this.state = to;

    this.onTransition?.(from, to, reason);
  }

  /** Full transition history, oldest first. Returns a copy. */
  getHistory(): LifecycleEvent[] {
    return [...this.history];
  }

  isTerminal(): boolean {
    return TERMINAL_STATES.includes(this.state);
  }

  /**
   * Milliseconds from creation until work ended — or until now, if the
   * execution is still live.
   */
  getDuration(): number {
    const createdAt = this.history[0]?.at.getTime() ?? 0;

    if (this.isTerminal()) {
      const firstTerminal = this.history.find((event) =>
        TERMINAL_STATES.includes(event.to),
      );
      return (firstTerminal?.at.getTime() ?? createdAt) - createdAt;
    }

    return Date.now() - createdAt;
  }
}
