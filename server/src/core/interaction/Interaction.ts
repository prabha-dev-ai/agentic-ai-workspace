import type { InteractionType } from './InteractionType.ts';
import type { InteractionStatus } from './InteractionStatus.ts';
import type { UserResponse } from './UserResponse.ts';

// The interaction model: one paused point in an agent's work, waiting on
// a human. Created in the Pending status; resolves to exactly one
// terminal outcome. Mirrors Stream's shape — one object serves both the
// resolver (respond/cancel/timeout) and the waiter (wait()).
export interface Interaction {
  readonly id: string;
  /** The agent execution this interaction is pausing, if any — interactions
   *  can also stand alone, outside any tracked agent lifecycle. */
  readonly agentId: string | undefined;
  readonly type: InteractionType;
  /** What's being asked of the human. */
  readonly prompt: string;
  readonly metadata: Record<string, unknown> | undefined;
  readonly status: InteractionStatus;
  readonly createdAt: Date;
  readonly resolvedAt: Date | undefined;
  readonly response: UserResponse | undefined;

  /** Resolve with a human's response. Throws if not Pending. */
  respond(response: UserResponse): void;

  /** Resolve as cancelled — the request is no longer needed. Throws if not Pending. */
  cancel(): void;

  /** Resolve as timed out — no response arrived in time. Throws if not Pending. */
  timeout(): void;

  /** Await this interaction's outcome: the response, or undefined if it
   *  was cancelled or timed out instead of answered. */
  wait(): Promise<UserResponse | undefined>;
}
