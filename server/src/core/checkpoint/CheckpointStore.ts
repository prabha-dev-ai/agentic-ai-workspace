import type { Checkpoint } from './Checkpoint.ts';

export interface CheckpointStoreStats {
  saves: number;
  /** getLatest() calls that found a checkpoint. */
  recoveries: number;
  /** getLatest() calls that found nothing. */
  misses: number;
  size: number;
}

// The checkpoint store abstraction every backend implements — in-memory
// today, swappable later (a database, object storage) through the
// checkpoint-store-provider plugin capability without touching call
// sites. A subject can accumulate many checkpoints over time; getLatest
// is the primary recovery read path.
export interface CheckpointStore<T = unknown> {
  readonly name: string;
  readonly size: number;

  save(subjectId: string, data: T, metadata?: Record<string, unknown>): Checkpoint<T>;
  getLatest(subjectId: string): Checkpoint<T> | undefined;
  /** Every checkpoint for a subject, oldest first. */
  list(subjectId: string): Checkpoint<T>[];
  clear(subjectId: string): void;

  getStats(): CheckpointStoreStats;
}
