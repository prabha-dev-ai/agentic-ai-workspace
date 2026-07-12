import type { Checkpoint } from './Checkpoint.ts';
import type { CheckpointStoreStats } from './CheckpointStore.ts';

// The async sibling of CheckpointStore<T> (AAI-036) — a NEW, additive
// interface. CheckpointStore's save/getLatest/list/clear are synchronous;
// CheckpointManager.checkpoint()/recover() call them without awaiting,
// and there is no synchronous Node.js Postgres client. Rather than break
// that contract, this is a separate contract callers opt into explicitly
// via CheckpointManager.checkpointAsync()/recoverAsync() — see
// AsyncCache.ts's module comment for the fuller rationale, which applies
// identically here.
export interface AsyncCheckpointStore<T = unknown> {
  readonly name: string;

  save(subjectId: string, data: T, metadata?: Record<string, unknown>): Promise<Checkpoint<T>>;
  getLatest(subjectId: string): Promise<Checkpoint<T> | undefined>;
  /** Every checkpoint for a subject, oldest first. */
  list(subjectId: string): Promise<Checkpoint<T>[]>;
  clear(subjectId: string): Promise<void>;

  getStats(): Promise<CheckpointStoreStats>;
}
