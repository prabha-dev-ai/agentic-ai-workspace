import { CheckpointError } from './CheckpointError.ts';
import { InMemoryCheckpointStore } from './InMemoryCheckpointStore.ts';
import type { Checkpoint } from './Checkpoint.ts';
import type { CheckpointStore } from './CheckpointStore.ts';
import type { RecoveryResult } from './RecoveryResult.ts';
import { EventType } from '../events/EventType.ts';
import type { EventBus } from '../events/EventBus.ts';

export interface CheckpointManagerOptions {
  /** The active backend. Defaults to a fresh InMemoryCheckpointStore. */
  store?: CheckpointStore;
}

export interface CheckpointManagerDiagnostics {
  storeName: string;
  totalCheckpoints: number;
  saves: number;
  recoveries: number;
  recoveryMisses: number;
}

// The checkpoint hub: components save state under a subject id and
// recover the latest snapshot for it later — across a restart, after a
// crash, wherever "resume where this left off" applies. Wraps exactly
// ONE active CheckpointStore (swappable via useStore(), the same
// single-backend idiom as the vector store/embedding provider — a
// process wants one durable checkpoint destination, not many named
// ones) rather than a multi-store registry. Every save/recover publishes
// onto the framework event bus when connected, correlated by subject id.
export class CheckpointManager {
  private store: CheckpointStore;
  private eventBus: EventBus | undefined;

  constructor(options: CheckpointManagerOptions = {}) {
    this.store = options.store ?? new InMemoryCheckpointStore();
  }

  /** Swap the active backend — e.g. to a plugin-contributed durable store. */
  useStore(store: CheckpointStore): void {
    this.store = store;
  }

  getStore(): CheckpointStore {
    return this.store;
  }

  /** Publish checkpoint saved/recovered/recovery-failed events onto the
   *  framework event bus, correlated by subject id. */
  connectEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  checkpoint<T = unknown>(
    subjectId: string,
    data: T,
    metadata?: Record<string, unknown>,
  ): Checkpoint<T> {
    if (typeof subjectId !== 'string' || subjectId.trim() === '') {
      throw new CheckpointError('A checkpoint needs a non-empty subject id.');
    }

    const checkpoint = this.store.save(subjectId, data, metadata) as Checkpoint<T>;

    this.publish(EventType.CheckpointSaved, subjectId, { checkpointId: checkpoint.id });

    return checkpoint;
  }

  /** Attempt to recover the latest checkpoint for a subject. Never throws
   *  for "nothing found" — that's a RecoveryResult, not an error. */
  recover<T = unknown>(subjectId: string): RecoveryResult<T> {
    const checkpoint = this.store.getLatest(subjectId) as Checkpoint<T> | undefined;

    if (checkpoint) {
      this.publish(EventType.CheckpointRecovered, subjectId, { checkpointId: checkpoint.id });
      return { recovered: true, checkpoint };
    }

    const reason = `No checkpoint found for subject "${subjectId}".`;
    this.publish(EventType.CheckpointRecoveryFailed, subjectId, { reason });
    return { recovered: false, subjectId, reason };
  }

  getDiagnostics(): CheckpointManagerDiagnostics {
    const stats = this.store.getStats();
    return {
      storeName: this.store.name,
      totalCheckpoints: stats.size,
      saves: stats.saves,
      recoveries: stats.recoveries,
      recoveryMisses: stats.misses,
    };
  }

  private publish(
    type: EventType,
    subjectId: string,
    extra: Record<string, unknown>,
  ): void {
    if (!this.eventBus) {
      return;
    }

    this.eventBus.publish({
      type,
      source: 'checkpoint-manager',
      correlationId: subjectId,
      payload: { subjectId, ...extra },
    });
  }
}
