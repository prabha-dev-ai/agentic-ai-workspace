import { retrieveDocuments } from './retriever.service.ts';
import type { KnowledgeStore } from './knowledge-store.ts';
import type { EmbeddingService } from '../core/embeddings/index.ts';
import type { SearchResult, VectorStore } from '../core/vectorstore/index.ts';

// Hybrid retrieval: keyword and vector search answer different questions.
// Keyword matching finds documents that share the query's exact terms
// (precise, but blind to synonyms); vector similarity finds documents
// that mean the same thing (robust to wording, but fuzzy). Combining
// both — the classic weighted-sum fusion — beats either alone.
//
// This module composes the EXISTING retrievers, it does not rescore:
// keyword evidence comes from retriever.service.ts, vector evidence
// from the vector store, and the fusion here only normalizes, weighs,
// merges and deduplicates.
//
// Integration contract: a document must be stored in the knowledge
// store and the vector store under the SAME id for its evidence to be
// merged. Ids that appear in only one source still rank — with zero
// contribution from the other.

export class RetrievalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export const RetrievalSource = {
  Keyword: 'keyword',
  Vector: 'vector',
} as const;

export type RetrievalSource =
  (typeof RetrievalSource)[keyof typeof RetrievalSource];

export interface HybridRetrievalResult {
  id: string;
  text: string;
  /** Present when the knowledge store knows the document. */
  title?: string;
  /** keywordWeight * keywordScore + vectorWeight * vectorScore. */
  combinedScore: number;
  /** Normalized to [0, 1] within this query; 0 = not found by keyword. */
  keywordScore: number;
  /** Normalized to [0, 1] within this query; 0 = not found by vector. */
  vectorScore: number;
  /** Which retrievers produced evidence for this document. */
  sources: RetrievalSource[];
}

export interface HybridRetrieverOptions {
  /** Relative weight of keyword evidence. Default 0.5. */
  keywordWeight?: number;
  /** Relative weight of vector evidence. Default 0.5. */
  vectorWeight?: number;
}

export interface HybridRetrievalOptions {
  /** Maximum results returned (default 3). Each source also contributes
   *  at most this many candidates before fusion. */
  limit?: number;
}

export interface HybridRetrieverDiagnostics {
  totalQueries: number;
  /** Candidates each source produced across all queries. */
  keywordCandidates: number;
  vectorCandidates: number;
  /** Vector side skipped because the vector store was empty. */
  vectorSearchesSkipped: number;
  /** Queries that failed after validation (embedding/search errors). */
  failures: number;
}

export interface HybridRetriever {
  retrieve(
    query: string,
    options?: HybridRetrievalOptions,
  ): Promise<HybridRetrievalResult[]>;
  getDiagnostics(): HybridRetrieverDiagnostics;
}

export interface HybridRetrieverDependencies {
  knowledgeStore: KnowledgeStore;
  embeddingService: EmbeddingService;
  vectorStore: VectorStore;
}

// Min-max normalization per source, so scores from incompatible scales
// (keyword term counts vs cosine similarities) become comparable before
// weighting. Convention: when every candidate scores the same (including
// a single candidate), each counts fully (1) — a 0/0 must never NaN a
// ranking. Trade-off: with distinct scores, the worst candidate of a
// source normalizes to 0, as if that source had not found it.
function makeNormalizer(scores: number[]): (score: number) => number {
  const min = Math.min(...scores);
  const max = Math.max(...scores);

  if (max === min) {
    return () => 1;
  }
  return (score) => (score - min) / (max - min);
}

export function createHybridRetriever(
  dependencies: HybridRetrieverDependencies,
  options: HybridRetrieverOptions = {},
): HybridRetriever {
  const { knowledgeStore, embeddingService, vectorStore } = dependencies;

  const keywordWeight = options.keywordWeight ?? 0.5;
  const vectorWeight = options.vectorWeight ?? 0.5;

  if (!Number.isFinite(keywordWeight) || keywordWeight < 0) {
    throw new RetrievalValidationError('keywordWeight must be a non-negative number.');
  }
  if (!Number.isFinite(vectorWeight) || vectorWeight < 0) {
    throw new RetrievalValidationError('vectorWeight must be a non-negative number.');
  }
  if (keywordWeight + vectorWeight === 0) {
    throw new RetrievalValidationError(
      'At least one of keywordWeight and vectorWeight must be positive.',
    );
  }

  let totalQueries = 0;
  let keywordCandidates = 0;
  let vectorCandidates = 0;
  let vectorSearchesSkipped = 0;
  let failures = 0;

  return {
    async retrieve(query, retrievalOptions = {}) {
      totalQueries++;

      const limit = retrievalOptions.limit ?? 3;
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RetrievalValidationError('limit must be a positive integer.');
      }
      if (typeof query !== 'string' || query.trim() === '') {
        throw new RetrievalValidationError(
          'Cannot retrieve with an empty query. Provide a non-empty string.',
        );
      }

      try {
        const keywordResults = retrieveDocuments(knowledgeStore, query, { limit });
        keywordCandidates += keywordResults.length;

        // Embedding the query costs an API call — never spend it when
        // the vector store has nothing to search.
        let vectorResults: SearchResult[] = [];
        if (vectorStore.getDiagnostics().documentCount > 0) {
          const embedded = await embeddingService.embed(query);
          vectorResults = await vectorStore.search(embedded.vector, { topK: limit });
          vectorCandidates += vectorResults.length;
        } else {
          vectorSearchesSkipped++;
        }

        return fuse(keywordResults, vectorResults, limit);
      } catch (error) {
        failures++;
        throw error;
      }
    },

    getDiagnostics() {
      return {
        totalQueries,
        keywordCandidates,
        vectorCandidates,
        vectorSearchesSkipped,
        failures,
      };
    },
  };

  function fuse(
    keywordResults: ReturnType<typeof retrieveDocuments>,
    vectorResults: SearchResult[],
    limit: number,
  ): HybridRetrievalResult[] {
    const normalizeKeyword = makeNormalizer(keywordResults.map((r) => r.score));
    const normalizeVector = makeNormalizer(vectorResults.map((r) => r.score));

    // Merge by document id — one entry per document, however many
    // sources found it.
    const merged = new Map<string, HybridRetrievalResult>();

    for (const { document, score } of keywordResults) {
      merged.set(document.id, {
        id: document.id,
        text: document.content,
        title: document.title,
        combinedScore: 0,
        keywordScore: normalizeKeyword(score),
        vectorScore: 0,
        sources: [RetrievalSource.Keyword],
      });
    }

    for (const { document, score } of vectorResults) {
      const existing = merged.get(document.id);
      if (existing) {
        existing.vectorScore = normalizeVector(score);
        existing.sources.push(RetrievalSource.Vector);
      } else {
        merged.set(document.id, {
          id: document.id,
          text: document.text,
          combinedScore: 0,
          keywordScore: 0,
          vectorScore: normalizeVector(score),
          sources: [RetrievalSource.Vector],
        });
      }
    }

    const results = [...merged.values()];
    for (const result of results) {
      result.combinedScore =
        keywordWeight * result.keywordScore + vectorWeight * result.vectorScore;
    }

    return results
      .sort(
        (a, b) =>
          b.combinedScore - a.combinedScore ||
          // Deterministic tiebreaker so equal scores always rank the same.
          a.id.localeCompare(b.id),
      )
      .slice(0, limit);
  }
}
