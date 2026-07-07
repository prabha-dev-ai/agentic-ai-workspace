import type { InteractionType } from './InteractionType.ts';
import type { UserResponse } from './UserResponse.ts';

// What an interaction emits, as a discriminated union — same rationale as
// StreamEvent: a consumer switching on `type` gets exactly the fields
// that moment carries, with no optional-property ambiguity.
export type InteractionEvent =
  | {
      type: 'requested';
      interactionId: string;
      agentId: string | undefined;
      interactionType: InteractionType;
      prompt: string;
      timestamp: Date;
    }
  | {
      type: 'resolved';
      interactionId: string;
      response: UserResponse;
      timestamp: Date;
    }
  | {
      type: 'cancelled';
      interactionId: string;
      timestamp: Date;
    }
  | {
      type: 'timedout';
      interactionId: string;
      timestamp: Date;
    };
