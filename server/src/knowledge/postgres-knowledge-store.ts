import type { AsyncKnowledgeStore } from './async-knowledge-store.ts';
import type { KnowledgeDocument } from './knowledge.types.ts';
import type { PgClient } from '../core/database/PgClient.ts';

export class KnowledgeStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface PostgresKnowledgeStoreOptions {
  /** Table name. Default 'knowledge_documents'. */
  tableName?: string;
}

interface DocumentRow {
  id: string;
  title: string;
  content: string;
}

function rowToDocument(row: DocumentRow): KnowledgeDocument {
  return { id: row.id, title: row.title, content: row.content };
}

// Postgres-backed AsyncKnowledgeStore: same add/getAll/getById surface as
// knowledge-store.ts's in-memory KnowledgeStore, and the same validation
// rules (non-empty id/content, silent overwrites rejected as data loss),
// just durable. See server/migrations/004_knowledge_store.sql.
export class PostgresKnowledgeStore implements AsyncKnowledgeStore {
  private readonly client: PgClient;
  private readonly tableName: string;
  private connected = false;

  constructor(client: PgClient, options: PostgresKnowledgeStoreOptions = {}) {
    this.client = client;
    this.tableName = options.tableName ?? 'knowledge_documents';
  }

  async connect(): Promise<void> {
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL
      );`,
    );
    this.connected = true;
  }

  async add(document: KnowledgeDocument): Promise<void> {
    this.assertConnected();

    if (document.id.trim() === '') {
      throw new KnowledgeStoreError('A knowledge document needs a non-empty id.');
    }
    if (document.content.trim() === '') {
      throw new KnowledgeStoreError(`Document "${document.id}" has no content.`);
    }

    try {
      await this.client.query(
        `INSERT INTO ${this.tableName} (id, title, content) VALUES ($1, $2, $3);`,
        [document.id, document.title, document.content],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new KnowledgeStoreError(`Document "${document.id}" already exists.`);
      }
      throw error;
    }
  }

  async getAll(): Promise<KnowledgeDocument[]> {
    this.assertConnected();

    const result = await this.client.query<DocumentRow>(
      `SELECT id, title, content FROM ${this.tableName};`,
    );
    return result.rows.map(rowToDocument);
  }

  async getById(id: string): Promise<KnowledgeDocument | undefined> {
    this.assertConnected();

    const result = await this.client.query<DocumentRow>(
      `SELECT id, title, content FROM ${this.tableName} WHERE id = $1;`,
      [id],
    );
    const row = result.rows[0];
    return row ? rowToDocument(row) : undefined;
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new KnowledgeStoreError(
        'PostgresKnowledgeStore.connect() must resolve before the store is used.',
      );
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}
