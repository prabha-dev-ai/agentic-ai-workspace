// What a human sends back, shaped by which InteractionType they're
// answering. A discriminated union rather than one shape with optional
// fields — an approval's `approved` and an input's `value` don't mix.
export type UserResponse =
  | { type: 'approval'; approved: boolean; comment?: string }
  | { type: 'input'; value: string };
