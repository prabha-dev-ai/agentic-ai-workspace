// An interaction's lifecycle: created and awaiting a human (Pending),
// then exactly one terminal outcome.
export const InteractionStatus = {
  Pending: 'pending',
  Resolved: 'resolved',
  Cancelled: 'cancelled',
  TimedOut: 'timedout',
} as const;

export type InteractionStatus = (typeof InteractionStatus)[keyof typeof InteractionStatus];

const TERMINAL_STATUSES: ReadonlySet<InteractionStatus> = new Set([
  InteractionStatus.Resolved,
  InteractionStatus.Cancelled,
  InteractionStatus.TimedOut,
]);

export function isTerminal(status: InteractionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
