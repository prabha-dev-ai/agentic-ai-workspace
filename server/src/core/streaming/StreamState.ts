// A stream's lifecycle: created with no chunks yet (Pending), producing
// chunks (Active), then exactly one terminal state. A const-object union
// instead of a TS enum — Node's type stripping cannot run enums (same
// pattern as LogLevel, SpanStatus, MetricType).
export const StreamState = {
  Pending: 'pending',
  Active: 'active',
  Completed: 'completed',
  Error: 'error',
  Cancelled: 'cancelled',
} as const;

export type StreamState = (typeof StreamState)[keyof typeof StreamState];

const TERMINAL_STATES: ReadonlySet<StreamState> = new Set([
  StreamState.Completed,
  StreamState.Error,
  StreamState.Cancelled,
]);

export function isTerminal(state: StreamState): boolean {
  return TERMINAL_STATES.has(state);
}
