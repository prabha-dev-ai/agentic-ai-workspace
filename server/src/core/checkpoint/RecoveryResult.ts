import type { Checkpoint } from './Checkpoint.ts';

// The outcome of a recovery attempt, as a discriminated union — same
// rationale as every other event/result union in this codebase: a
// consumer switching on `recovered` gets exactly the fields that outcome
// carries, with no "checkpoint might be undefined even though recovered
// is true" ambiguity.
export type RecoveryResult<T = unknown> =
  | { recovered: true; checkpoint: Checkpoint<T> }
  | { recovered: false; subjectId: string; reason: string };
