import type { SearchOptions } from './SearchOptions.ts';
import type { SearchResult } from './SearchResult.ts';
import type { VectorDocument } from './VectorDocument.ts';

export interface VectorStoreDiagnostics {
  /** Documents currently in the store. */
  documentCount: number;
  /** Locked from the first inserted document; undefined while empty. */
  dimensions: number | undefined;
  /** Lifetime counters — they survive clear(). */
  totalDocumentsAdded: number;
  totalSearches: number;
  totalDeletes: number;
}

// The storage abstraction: normalized documents in, ranked results out.
// Every method is async even though the in-memory implementation never
// waits — the interface must fit real backends (MongoDB later) without
// changing a single caller.
export interface VectorStore {
  /** Insert a new document. Rejects duplicates — use update() to replace. */
  add(document: VectorDocument): Promise<void>;

  /** Insert many documents. Validates ALL of them before inserting ANY. */
  addBatch(documents: VectorDocument[]): Promise<void>;

  /** Replace an existing document. Rejects unknown ids. */
  update(document: VectorDocument): Promise<void>;

  /** Remove a document. Rejects unknown ids. */
  delete(id: string): Promise<void>;

  /** Fetch one document, or undefined if the id is unknown. */
  get(id: string): Promise<VectorDocument | undefined>;

  /** Rank stored documents against a query vector, best first. */
  search(vector: number[], options?: SearchOptions): Promise<SearchResult[]>;

  /** Remove every document and release the dimension lock. */
  clear(): Promise<void>;

  getDiagnostics(): VectorStoreDiagnostics;
}
