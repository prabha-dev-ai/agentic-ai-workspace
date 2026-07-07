// The human-in-the-loop API surface. Consumers import from this barrel
// only — the individual files are implementation layout.

export { InteractionError } from './InteractionError.ts';
export { InteractionType } from './InteractionType.ts';
export { InteractionStatus, isTerminal } from './InteractionStatus.ts';
export type { UserResponse } from './UserResponse.ts';
export type { InteractionEvent } from './InteractionEvent.ts';
export type { Interaction } from './Interaction.ts';
export { InteractionManager } from './InteractionManager.ts';
export type {
  InteractionObserver,
  RequestOptions,
  InteractionManagerOptions,
  InteractionManagerDiagnostics,
} from './InteractionManager.ts';
