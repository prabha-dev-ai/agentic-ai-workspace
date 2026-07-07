// What kind of human input a request needs. A const-object union instead
// of a TS enum — Node's type stripping cannot run enums (same pattern as
// AgentState, StreamState).
export const InteractionType = {
  /** A yes/no gate on an action the agent wants to take. */
  Approval: 'approval',
  /** A free-form value the agent needs from a human to continue. */
  Input: 'input',
} as const;

export type InteractionType = (typeof InteractionType)[keyof typeof InteractionType];
