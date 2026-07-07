// Span outcome. A const-object union instead of a TS enum: Node's type
// stripping cannot run enums (same pattern as LogLevel and EventType).
export const SpanStatus = {
  /** end() was never given an explicit status. */
  Unset: 'unset',
  Ok: 'ok',
  Error: 'error',
} as const;

export type SpanStatus = (typeof SpanStatus)[keyof typeof SpanStatus];
