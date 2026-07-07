// The checkpoint model: a saved snapshot of some subject's state at a
// point in time — an agent execution, a workflow run, anything that
// needs to survive a restart. V defaults to unknown so the interface
// mirrors cleanly into the plugin capability contract, which cannot
// express a generic (same rationale as Cache<V>).
export interface Checkpoint<T = unknown> {
  readonly id: string;
  /** What this checkpoint belongs to — an agent id, a workflow run id, etc. */
  readonly subjectId: string;
  readonly data: T;
  readonly createdAt: Date;
  readonly metadata: Record<string, unknown> | undefined;
}
