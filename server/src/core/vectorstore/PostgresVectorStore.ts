import { SimilarityMetric } from './Similarity.ts';
import {
  DimensionMismatchError,
  DocumentNotFoundError,
  DuplicateDocumentError,
  VectorValidationError,
} from './VectorErrors.ts';
import type { PgClient } from '../database/PgClient.ts';
import type { SearchOptions } from './SearchOptions.ts';
import type { SearchResult } from './SearchResult.ts';
import type { VectorDocument } from './VectorDocument.ts';
import type { VectorStore, VectorStoreDiagnostics } from './VectorStore.ts';

export interface PostgresVectorStoreOptions {
  /** Table name. Default 'vector_documents'. */
  tableName?: string;
  /** Fixed vector width — pgvector columns are sized at creation time,
   *  unlike InMemoryVectorStore's first-insert dimension lock. Must match
   *  the embedding model in use (see EmbeddingModel.ts / env.postgres). */
  dimensions: number;
}

// pgvector's three distance operators map onto SimilarityMetric exactly:
// <=> is cosine DISTANCE (1 - cosine similarity), <#> is negative inner
// product (so negating it recovers dot product), <-> is euclidean
// distance. Same "higher score = more similar" contract as
// Similarity.ts's similarityScore(), just computed server-side.
const METRIC_OPERATORS: Record<SimilarityMetric, string> = {
  [SimilarityMetric.Cosine]: '<=>',
  [SimilarityMetric.DotProduct]: '<#>',
  [SimilarityMetric.Euclidean]: '<->',
};

function toScore(metric: SimilarityMetric, distance: number): number {
  switch (metric) {
    case SimilarityMetric.Cosine:
      return 1 - distance;
    case SimilarityMetric.DotProduct:
      return -distance;
    case SimilarityMetric.Euclidean:
      return 1 / (1 + distance);
  }
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

interface DocumentRow {
  id: string;
  text: string;
  vector: string;
  metadata: VectorDocument['metadata'] | null;
}

function rowToDocument(row: DocumentRow): VectorDocument {
  const document: VectorDocument = {
    id: row.id,
    text: row.text,
    vector: parsePgVector(row.vector),
  };
  if (row.metadata) {
    document.metadata = row.metadata;
  }
  return document;
}

// pgvector returns vectors as their text form, e.g. "[1,2,3]" — never a
// JS array, even through the `pg` driver's normal type parsing.
function parsePgVector(literal: string): number[] {
  return literal
    .slice(1, -1)
    .split(',')
    .map((value) => Number(value));
}

// pgvector-backed VectorStore: the same interface as InMemoryVectorStore,
// so every existing caller (hybrid-retriever, the vector-store plugin,
// bootstrap's TOKENS.vectorStore) works unchanged against a real,
// restart-durable Postgres table. Requires the pgvector extension
// (`CREATE EXTENSION IF NOT EXISTS vector;`) — see
// server/migrations/002_vector_store.sql.
//
// getDiagnostics() stays synchronous per the VectorStore contract, so
// documentCount/totals are tracked client-side rather than queried live —
// exact for a single-process owner of the table (the common case), but
// can drift if multiple processes write the same table concurrently. That
// trade-off is documented, not hidden: see docs/architecture/adr for
// AAI-036, "Design Decisions".
export class PostgresVectorStore implements VectorStore {
  private readonly client: PgClient;
  private readonly tableName: string;
  private readonly dimensions: number;

  private documentCount = 0;
  private totalDocumentsAdded = 0;
  private totalSearches = 0;
  private totalDeletes = 0;
  private connected = false;

  constructor(client: PgClient, options: PostgresVectorStoreOptions) {
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1) {
      throw new VectorValidationError('dimensions must be a positive integer.');
    }
    this.client = client;
    this.tableName = options.tableName ?? 'vector_documents';
    this.dimensions = options.dimensions;
  }

  /** Create the table/extension if missing and prime documentCount from
   *  the current row count. Call once before use — mirrors the explicit
   *  async-init step every network-backed store in this story needs,
   *  since constructors can't be async. */
  async connect(): Promise<void> {
    await this.client.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        vector vector(${this.dimensions}) NOT NULL,
        metadata JSONB
      );`,
    );

    const result = await this.client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${this.tableName};`,
    );
    this.documentCount = Number(result.rows[0]?.count ?? 0);
    this.connected = true;
  }

  async add(document: VectorDocument): Promise<void> {
    this.assertConnected();
    this.validateDocument(document);

    try {
      await this.client.query(
        `INSERT INTO ${this.tableName} (id, text, vector, metadata) VALUES ($1, $2, $3, $4);`,
        [document.id, document.text, toVectorLiteral(document.vector), document.metadata ?? null],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateDocumentError(document.id);
      }
      throw error;
    }

    this.documentCount++;
    this.totalDocumentsAdded++;
  }

  async addBatch(documents: VectorDocument[]): Promise<void> {
    this.assertConnected();
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new VectorValidationError('addBatch needs at least one document.');
    }

    const seen = new Set<string>();
    for (const document of documents) {
      this.validateDocument(document);
      if (seen.has(document.id)) {
        throw new DuplicateDocumentError(document.id);
      }
      seen.add(document.id);
    }

    // One statement per document inside a single round of validated
    // inserts — no partial commits: if any insert fails (e.g. a
    // pre-existing id), earlier inserts in this call are rolled back.
    await this.client.query('BEGIN;');
    try {
      for (const document of documents) {
        try {
          await this.client.query(
            `INSERT INTO ${this.tableName} (id, text, vector, metadata) VALUES ($1, $2, $3, $4);`,
            [document.id, document.text, toVectorLiteral(document.vector), document.metadata ?? null],
          );
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new DuplicateDocumentError(document.id);
          }
          throw error;
        }
      }
      await this.client.query('COMMIT;');
    } catch (error) {
      await this.client.query('ROLLBACK;');
      throw error;
    }

    this.documentCount += documents.length;
    this.totalDocumentsAdded += documents.length;
  }

  async update(document: VectorDocument): Promise<void> {
    this.assertConnected();
    this.validateDocument(document);

    const result = await this.client.query(
      `UPDATE ${this.tableName} SET text = $2, vector = $3, metadata = $4 WHERE id = $1;`,
      [document.id, document.text, toVectorLiteral(document.vector), document.metadata ?? null],
    );

    if (result.rowCount === 0) {
      throw new DocumentNotFoundError(document.id);
    }
  }

  async delete(id: string): Promise<void> {
    this.assertConnected();

    const result = await this.client.query(`DELETE FROM ${this.tableName} WHERE id = $1;`, [id]);

    if (result.rowCount === 0) {
      throw new DocumentNotFoundError(id);
    }

    this.documentCount--;
    this.totalDeletes++;
  }

  async get(id: string): Promise<VectorDocument | undefined> {
    this.assertConnected();

    const result = await this.client.query<DocumentRow>(
      `SELECT id, text, vector::text AS vector, metadata FROM ${this.tableName} WHERE id = $1;`,
      [id],
    );

    const row = result.rows[0];
    return row ? rowToDocument(row) : undefined;
  }

  async search(vector: number[], options: SearchOptions = {}): Promise<SearchResult[]> {
    this.assertConnected();
    this.totalSearches++;

    const topK = options.topK ?? 5;
    if (!Number.isInteger(topK) || topK < 1) {
      throw new VectorValidationError('topK must be a positive integer.');
    }
    this.validateVector(vector);
    this.assertDimensions(vector);

    const metric = options.metric ?? SimilarityMetric.Cosine;
    const operator = METRIC_OPERATORS[metric];

    // The metadata filter is applied server-side, BEFORE the LIMIT — it
    // must be, or a match outside the top-K nearest neighbors would be
    // silently dropped instead of surfacing once non-matches are excluded
    // (the same ranking bug InMemoryVectorStore avoids by filtering
    // before sorting/slicing, not after).
    const { clause, params } = buildFilterClause(options.filter);
    const queryParams = [toVectorLiteral(vector), ...params, topK];

    const result = await this.client.query<DocumentRow & { distance: number }>(
      `SELECT id, text, vector::text AS vector, metadata, (vector ${operator} $1) AS distance
       FROM ${this.tableName}
       WHERE 1 = 1 ${clause}
       ORDER BY vector ${operator} $1
       LIMIT $${queryParams.length};`,
      queryParams,
    );

    return result.rows.map((row) => ({
      document: rowToDocument(row),
      score: toScore(metric, Number(row.distance)),
      metric,
    }));
  }

  async clear(): Promise<void> {
    this.assertConnected();
    await this.client.query(`DELETE FROM ${this.tableName};`);
    this.documentCount = 0;
  }

  getDiagnostics(): VectorStoreDiagnostics {
    return {
      documentCount: this.documentCount,
      dimensions: this.documentCount > 0 ? this.dimensions : undefined,
      totalDocumentsAdded: this.totalDocumentsAdded,
      totalSearches: this.totalSearches,
      totalDeletes: this.totalDeletes,
    };
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new VectorValidationError(
        'PostgresVectorStore.connect() must resolve before the store is used.',
      );
    }
  }

  private assertDimensions(vector: number[]): void {
    if (vector.length !== this.dimensions) {
      throw new DimensionMismatchError(this.dimensions, vector.length);
    }
  }

  private validateDocument(document: VectorDocument): void {
    if (typeof document.id !== 'string' || document.id.trim() === '') {
      throw new VectorValidationError('Document id must be a non-empty string.');
    }
    if (typeof document.text !== 'string') {
      throw new VectorValidationError('Document text must be a string.');
    }
    this.validateVector(document.vector);
    this.assertDimensions(document.vector);

    if (document.metadata !== undefined) {
      for (const [key, value] of Object.entries(document.metadata)) {
        const kind = typeof value;
        if (kind !== 'string' && kind !== 'number' && kind !== 'boolean') {
          throw new VectorValidationError(
            `Metadata value for "${key}" must be a string, number, or boolean.`,
          );
        }
      }
    }
  }

  private validateVector(vector: number[]): void {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new VectorValidationError('Vector must be a non-empty number array.');
    }
    if (!vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new VectorValidationError('Vector must contain only finite numbers.');
    }
  }
}

// JSONB containment (`@>`) expresses the same AND-of-equalities semantics
// as InMemoryVectorStore's matchesFilter — every filter key/value pair
// must be present in the row's metadata — but evaluated server-side, so
// it composes correctly with ORDER BY + LIMIT above.
function buildFilterClause(filter: SearchOptions['filter']): {
  clause: string;
  params: unknown[];
} {
  if (!filter || Object.keys(filter).length === 0) {
    return { clause: '', params: [] };
  }
  return { clause: 'AND metadata @> $2::jsonb', params: [JSON.stringify(filter)] };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}
