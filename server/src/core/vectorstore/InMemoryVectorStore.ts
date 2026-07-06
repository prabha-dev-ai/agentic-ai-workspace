import { SimilarityMetric, similarityScore } from './Similarity.ts';
import {
  DimensionMismatchError,
  DocumentNotFoundError,
  DuplicateDocumentError,
  VectorValidationError,
} from './VectorErrors.ts';
import type { SearchOptions } from './SearchOptions.ts';
import type { SearchResult } from './SearchResult.ts';
import type { VectorDocument } from './VectorDocument.ts';
import type { VectorStore, VectorStoreDiagnostics } from './VectorStore.ts';

// Documents are cloned on the way in AND on the way out: a caller
// mutating an array it still holds must never silently corrupt the
// index — the classic aliasing bug of in-memory stores.
function cloneDocument(document: VectorDocument): VectorDocument {
  const clone: VectorDocument = {
    id: document.id,
    text: document.text,
    vector: [...document.vector],
  };
  if (document.metadata) {
    clone.metadata = { ...document.metadata };
  }
  return clone;
}

function matchesFilter(
  metadata: VectorDocument['metadata'],
  filter: SearchOptions['filter'],
): boolean {
  if (!filter || Object.keys(filter).length === 0) {
    return true;
  }
  if (!metadata) {
    return false;
  }
  return Object.entries(filter).every(([key, value]) => metadata[key] === value);
}

// The reference implementation: a Map plus a linear scan. O(n) per
// search is exactly right for learning and for small corpora — real
// indexes (HNSW, IVF) exist to beat this scan, and a database-backed
// implementation can replace this class behind the same interface.
export class InMemoryVectorStore implements VectorStore {
  private readonly documents = new Map<string, VectorDocument>();

  // Locked by the first inserted document, released when the store
  // empties — mixing 384- and 1536-dimensional vectors in one index is
  // always a bug, caught here instead of as nonsense scores.
  private lockedDimensions: number | undefined;

  private totalDocumentsAdded = 0;
  private totalSearches = 0;
  private totalDeletes = 0;

  async add(document: VectorDocument): Promise<void> {
    this.validateDocument(document);
    if (this.documents.has(document.id)) {
      throw new DuplicateDocumentError(document.id);
    }
    this.assertDimensions(document.vector);

    this.insert(document);
  }

  async addBatch(documents: VectorDocument[]): Promise<void> {
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new VectorValidationError('addBatch needs at least one document.');
    }

    // Validate EVERYTHING before inserting ANYTHING: a bad document at
    // position 40 must not leave positions 0-39 half-committed.
    const expected = this.lockedDimensions ?? documents[0]?.vector.length;
    const seen = new Set<string>();

    for (const document of documents) {
      this.validateDocument(document);
      if (this.documents.has(document.id) || seen.has(document.id)) {
        throw new DuplicateDocumentError(document.id);
      }
      seen.add(document.id);

      if (expected !== undefined && document.vector.length !== expected) {
        throw new DimensionMismatchError(expected, document.vector.length);
      }
    }

    for (const document of documents) {
      this.insert(document);
    }
  }

  async update(document: VectorDocument): Promise<void> {
    this.validateDocument(document);
    if (!this.documents.has(document.id)) {
      throw new DocumentNotFoundError(document.id);
    }
    this.assertDimensions(document.vector);

    this.documents.set(document.id, cloneDocument(document));
  }

  async delete(id: string): Promise<void> {
    if (!this.documents.delete(id)) {
      throw new DocumentNotFoundError(id);
    }
    this.totalDeletes++;

    if (this.documents.size === 0) {
      this.lockedDimensions = undefined;
    }
  }

  async get(id: string): Promise<VectorDocument | undefined> {
    const document = this.documents.get(id);
    return document ? cloneDocument(document) : undefined;
  }

  async search(
    vector: number[],
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    this.totalSearches++;

    const topK = options.topK ?? 5;
    if (!Number.isInteger(topK) || topK < 1) {
      throw new VectorValidationError('topK must be a positive integer.');
    }

    this.validateVector(vector);
    this.assertDimensions(vector);

    const metric = options.metric ?? SimilarityMetric.Cosine;

    const scored: { document: VectorDocument; score: number }[] = [];
    for (const document of this.documents.values()) {
      if (!matchesFilter(document.metadata, options.filter)) {
        continue;
      }
      scored.push({
        document,
        score: similarityScore(metric, vector, document.vector),
      });
    }

    scored.sort((a, b) => b.score - a.score);

    // Clone only the winners — the losers never leave the store.
    return scored.slice(0, topK).map(({ document, score }) => ({
      document: cloneDocument(document),
      score,
      metric,
    }));
  }

  async clear(): Promise<void> {
    this.documents.clear();
    this.lockedDimensions = undefined;
  }

  getDiagnostics(): VectorStoreDiagnostics {
    return {
      documentCount: this.documents.size,
      dimensions: this.lockedDimensions,
      totalDocumentsAdded: this.totalDocumentsAdded,
      totalSearches: this.totalSearches,
      totalDeletes: this.totalDeletes,
    };
  }

  private insert(document: VectorDocument): void {
    this.lockedDimensions ??= document.vector.length;
    this.documents.set(document.id, cloneDocument(document));
    this.totalDocumentsAdded++;
  }

  private assertDimensions(vector: number[]): void {
    if (
      this.lockedDimensions !== undefined &&
      vector.length !== this.lockedDimensions
    ) {
      throw new DimensionMismatchError(this.lockedDimensions, vector.length);
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
