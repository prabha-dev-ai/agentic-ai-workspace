import { randomUUID } from 'node:crypto';
import { CheckpointError } from './CheckpointError.ts';
import type { AsyncCheckpointStore } from './AsyncCheckpointStore.ts';
import type { Checkpoint } from './Checkpoint.ts';
import type { CheckpointStoreStats } from './CheckpointStore.ts';
import type { PgClient } from '../database/PgClient.ts';

export interface PostgresCheckpointStoreOptions {
  /** Table name. Default 'checkpoints'. */
  tableName?: string;
}

interface CheckpointRow {
  id: string;
  subject_id: string;
  data: unknown;
  created_at: Date;
  metadata: Record<string, unknown> | null;
}

function rowToCheckpoint<T>(row: CheckpointRow): Checkpoint<T> {
  return {
    id: row.id,
    subjectId: row.subject_id,
    data: row.data as T,
    createdAt: new Date(row.created_at),
    metadata: row.metadata ?? undefined,
  };
}

// Postgres-backed AsyncCheckpointStore: the same append-only history
// InMemoryCheckpointStore keeps (every save() is a new row, nothing is
// ever overwritten — list() is a full audit trail), just durable across
// restarts. See server/migrations/003_checkpoints.sql for the table.
//
// saves/recoveries/misses in getStats() are process-local counters, same
// as InMemoryCheckpointStore's own — those were never persisted state
// even in the in-memory reference implementation, just per-instance
// tallies. `size` (total row count) IS queried live from Postgres on
// every getStats() call, since getStats() is async here and a live COUNT
// is more honest than a client-side counter that could drift across
// multiple store instances/processes sharing one table.
export class PostgresCheckpointStore<T = unknown> implements AsyncCheckpointStore<T> {
  readonly name: string;
  private readonly client: PgClient;
  private readonly tableName: string;

  private saves = 0;
  private recoveries = 0;
  private misses = 0;
  private connected = false;

  constructor(client: PgClient, name = 'postgres', options: PostgresCheckpointStoreOptions = {}) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new CheckpointError('A checkpoint store needs a non-empty name.');
    }
    this.name = name;
    this.client = client;
    this.tableName = options.tableName ?? 'checkpoints';
  }

  /** Create the table if missing. Call once before use — see
   *  PostgresVectorStore.connect() for why this can't be the constructor. */
  async connect(): Promise<void> {
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        metadata JSONB
      );`,
    );
    await this.client.query(
      `CREATE INDEX IF NOT EXISTS ${this.tableName}_subject_id_created_at_idx
       ON ${this.tableName} (subject_id, created_at);`,
    );
    this.connected = true;
  }

  async save(subjectId: string, data: T, metadata?: Record<string, unknown>): Promise<Checkpoint<T>> {
    this.assertConnected();
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

    await this.client.query(
      `INSERT INTO ${this.tableName} (id, subject_id, data, created_at, metadata) VALUES ($1, $2, $3, $4, $5);`,
      [checkpoint.id, checkpoint.subjectId, JSON.stringify(data), checkpoint.createdAt, metadata ? JSON.stringify(metadata) : null],
    );
    this.saves++;

    return checkpoint;
  }

  async getLatest(subjectId: string): Promise<Checkpoint<T> | undefined> {
    this.assertConnected();

    const result = await this.client.query<CheckpointRow>(
      `SELECT id, subject_id, data, created_at, metadata FROM ${this.tableName}
       WHERE subject_id = $1 ORDER BY created_at DESC LIMIT 1;`,
      [subjectId],
    );

    const row = result.rows[0];
    if (!row) {
      this.misses++;
      return undefined;
    }

    this.recoveries++;
    return rowToCheckpoint<T>(row);
  }

  async list(subjectId: string): Promise<Checkpoint<T>[]> {
    this.assertConnected();

    const result = await this.client.query<CheckpointRow>(
      `SELECT id, subject_id, data, created_at, metadata FROM ${this.tableName}
       WHERE subject_id = $1 ORDER BY created_at ASC;`,
      [subjectId],
    );

    return result.rows.map((row) => rowToCheckpoint<T>(row));
  }

  async clear(subjectId: string): Promise<void> {
    this.assertConnected();
    await this.client.query(`DELETE FROM ${this.tableName} WHERE subject_id = $1;`, [subjectId]);
  }

  async getStats(): Promise<CheckpointStoreStats> {
    this.assertConnected();

    const result = await this.client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${this.tableName};`,
    );

    return {
      saves: this.saves,
      recoveries: this.recoveries,
      misses: this.misses,
      size: Number(result.rows[0]?.count ?? 0),
    };
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new CheckpointError(
        'PostgresCheckpointStore.connect() must resolve before the store is used.',
      );
    }
  }
}
