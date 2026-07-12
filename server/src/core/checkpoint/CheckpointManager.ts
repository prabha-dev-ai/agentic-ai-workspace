import { CheckpointError } from './CheckpointError.ts';
import { InMemoryCheckpointStore } from './InMemoryCheckpointStore.ts';
import type { Checkpoint } from './Checkpoint.ts';
import type { CheckpointStore } from './CheckpointStore.ts';
import type { AsyncCheckpointStore } from './AsyncCheckpointStore.ts';
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
  // Additive (AAI-036): a second, optional backend for the async
  // checkpointAsync()/recoverAsync() methods below. Unset by default —
  // there is no async default the way InMemoryCheckpointStore is the
  // sync default, since AsyncCheckpointStore always arrives from a real
  // network backend (Postgres) that only bootstrap knows how to build.
  private asyncStore: AsyncCheckpointStore | undefined;
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

  /** Swap in the active ASYNC backend — e.g. a plugin-contributed
   *  Postgres store. Independent of useStore()/getStore() above. */
  useAsyncStore(store: AsyncCheckpointStore): void {
    this.asyncStore = store;
  }

  getAsyncStore(): AsyncCheckpointStore | undefined {
    return this.asyncStore;
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

  /** The async twin of checkpoint(), against the async backend set via
   *  useAsyncStore(). Throws if none is configured — there is no default
   *  to silently fall back to (see the asyncStore field comment). */
  async checkpointAsync<T = unknown>(
    subjectId: string,
    data: T,
    metadata?: Record<string, unknown>,
  ): Promise<Checkpoint<T>> {
    if (typeof subjectId !== 'string' || subjectId.trim() === '') {
      throw new CheckpointError('A checkpoint needs a non-empty subject id.');
    }
    const store = this.requireAsyncStore();

    const checkpoint = (await store.save(subjectId, data, metadata)) as Checkpoint<T>;

    this.publish(EventType.CheckpointSaved, subjectId, { checkpointId: checkpoint.id });

    return checkpoint;
  }

  /** The async twin of recover(), against the async backend set via
   *  useAsyncStore(). Throws if none is configured. */
  async recoverAsync<T = unknown>(subjectId: string): Promise<RecoveryResult<T>> {
    const store = this.requireAsyncStore();
    const checkpoint = (await store.getLatest(subjectId)) as Checkpoint<T> | undefined;

    if (checkpoint) {
      this.publish(EventType.CheckpointRecovered, subjectId, { checkpointId: checkpoint.id });
      return { recovered: true, checkpoint };
    }

    const reason = `No checkpoint found for subject "${subjectId}".`;
    this.publish(EventType.CheckpointRecoveryFailed, subjectId, { reason });
    return { recovered: false, subjectId, reason };
  }

  async getAsyncDiagnostics(): Promise<CheckpointManagerDiagnostics> {
    const store = this.requireAsyncStore();
    const stats = await store.getStats();
    return {
      storeName: store.name,
      totalCheckpoints: stats.size,
      saves: stats.saves,
      recoveries: stats.recoveries,
      recoveryMisses: stats.misses,
    };
  }

  private requireAsyncStore(): AsyncCheckpointStore {
    if (!this.asyncStore) {
      throw new CheckpointError(
        'No async checkpoint store configured. Call useAsyncStore() first ' +
          '(e.g. with a Postgres-backed store) before using checkpointAsync()/recoverAsync().',
      );
    }
    return this.asyncStore;
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
