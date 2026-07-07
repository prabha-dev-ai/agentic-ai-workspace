import { randomUUID } from 'node:crypto';
import { CheckpointError } from './CheckpointError.ts';
import type { Checkpoint } from './Checkpoint.ts';
import type { CheckpointStore, CheckpointStoreStats } from './CheckpointStore.ts';

// The default checkpoint backend: an in-process Map of per-subject
// checkpoint histories. Every save() appends — nothing is ever
// overwritten in place — so list() is a full audit trail and getLatest()
// is just its last entry.
export class InMemoryCheckpointStore<T = unknown> implements CheckpointStore<T> {
  readonly name: string;
  private readonly checkpointsBySubject = new Map<string, Checkpoint<T>[]>();

  private saves = 0;
  private recoveries = 0;
  private misses = 0;

  constructor(name = 'in-memory') {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new CheckpointError('A checkpoint store needs a non-empty name.');
    }
    this.name = name;
  }

  save(subjectId: string, data: T, metadata?: Record<string, unknown>): Checkpoint<T> {
    if (typeof subjectId !== 'string' || subjectId.trim() === '') {
      throw new CheckpointError('A checkpoint needs a non-empty subject id.');
    }

    const checkpoint: Checkpoint<T> = {
      id: randomUUID(),
      subjectId,
      data,
      createdAt: new Date(),
      metadata,
    };

    const history = this.checkpointsBySubject.get(subjectId) ?? [];
    history.push(checkpoint);
    this.checkpointsBySubject.set(subjectId, history);
    this.saves++;

    return checkpoint;
  }

  getLatest(subjectId: string): Checkpoint<T> | undefined {
    const latest = this.checkpointsBySubject.get(subjectId)?.at(-1);

    if (latest) {
      this.recoveries++;
      return latest;
    }

    this.misses++;
    return undefined;
  }

  list(subjectId: string): Checkpoint<T>[] {
    return [...(this.checkpointsBySubject.get(subjectId) ?? [])];
  }

  clear(subjectId: string): void {
    this.checkpointsBySubject.delete(subjectId);
  }

  get size(): number {
    let total = 0;
    for (const history of this.checkpointsBySubject.values()) {
      total += history.length;
    }
    return total;
  }

  getStats(): CheckpointStoreStats {
    return {
      saves: this.saves,
      recoveries: this.recoveries,
      misses: this.misses,
      size: this.size,
    };
  }
}
