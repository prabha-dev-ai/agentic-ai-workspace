import type { HybridRetrievalResult } from './hybrid-retriever.ts';

// Knowledge ranking: an explainable re-ranking layer over retrieval
// candidates. Retrieval (AAI-024) answers "which documents might be
// relevant?"; ranking answers "in what order, and WHY?".
//
// The strategy is pluggable: a RankingStrategy only SCORES candidates
// and explains each score. Ordering, rank assignment, tiebreaking and
// limiting live once, in the KnowledgeRanker service — a strategy
// cannot get them wrong, and no strategy duplicates them.

export class RankingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class RankingValidationError extends RankingError {}

export class RankingStrategyError extends RankingError {
  readonly strategy: string;

  constructor(strategy: string, reason: string) {
    super(`Ranking strategy "${strategy}" failed: ${reason}`);
    this.strategy = strategy;
  }
}

/** A candidate to rank: identity, payload, and named relevance signals
 *  (each expected in [0, 1] — e.g. the hybrid retriever's normalized
 *  keyword/vector scores). */
export interface RankingCandidate {
  id: string;
  text: string;
  title?: string;
  signals: Record<string, number>;
}

/** One signal's share of a score — the unit of explainability. */
export interface SignalContribution {
  signal: string;
  /** The candidate's raw signal value (0 when the signal is absent). */
  value: number;
  weight: number;
  /** weight * value / totalWeight — contributions sum to the score. */
  contribution: number;
}

export interface RankingExplanation {
  strategy: string;
  contributions: SignalContribution[];
  /** Human-readable one-liner of the computation. */
  summary: string;
}

export interface ScoredCandidate {
  candidate: RankingCandidate;
  score: number;
  explanation: RankingExplanation;
}

export interface RankedResult extends ScoredCandidate {
  /** 1-based position after sorting — part of the explainable output. */
  rank: number;
}

export interface RankingStrategy {
  readonly name: string;
  /** Score every candidate (order does not matter — the service sorts). */
  score(
    query: string,
    candidates: RankingCandidate[],
  ): ScoredCandidate[] | Promise<ScoredCandidate[]>;
}

// ---- Default strategy: weighted signal combination -------------------

export interface WeightedRankingOptions {
  /**
   * Per-signal weights. When omitted, every signal present on any
   * candidate in the batch counts with weight 1. Weights are normalized
   * by their sum, so scores stay in [0, 1] for [0, 1] signals.
   */
  weights?: Record<string, number>;
}

export function createWeightedRankingStrategy(
  options: WeightedRankingOptions = {},
): RankingStrategy {
  const configuredWeights = options.weights;

  if (configuredWeights !== undefined) {
    const values = Object.values(configuredWeights);
    if (values.length === 0) {
      throw new RankingValidationError('weights must configure at least one signal.');
    }
    if (values.some((weight) => !Number.isFinite(weight) || weight < 0)) {
      throw new RankingValidationError('Every weight must be a non-negative number.');
    }
    if (values.every((weight) => weight === 0)) {
      throw new RankingValidationError('At least one weight must be positive.');
    }
  }

  return {
    name: 'weighted',

    score(_query, candidates) {
      for (const candidate of candidates) {
        validateCandidate(candidate);
      }

      // Configured weights win; otherwise every signal seen in the
      // batch counts equally — sensible without configuration, exact
      // with it.
      const weights =
        configuredWeights ?? equalWeightsFor(candidates);
      const totalWeight = Object.values(weights).reduce((sum, w) => sum + w, 0);

      return candidates.map((candidate) => {
        const contributions: SignalContribution[] = Object.entries(weights).map(
          ([signal, weight]) => {
            const value = candidate.signals[signal] ?? 0;
            return {
              signal,
              value,
              weight,
              contribution: (weight * value) / totalWeight,
            };
          },
        );

        const score = contributions.reduce(
          (sum, entry) => sum + entry.contribution,
          0,
        );

        return {
          candidate,
          score,
          explanation: {
            strategy: 'weighted',
            contributions,
            summary: summarize(contributions, score),
          },
        };
      });
    },
  };
}

function equalWeightsFor(candidates: RankingCandidate[]): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const candidate of candidates) {
    for (const signal of Object.keys(candidate.signals)) {
      weights[signal] = 1;
    }
  }
  // A batch with no signals at all still needs a non-zero denominator;
  // every candidate then scores 0, explained as such.
  if (Object.keys(weights).length === 0) {
    weights['none'] = 1;
  }
  return weights;
}

function summarize(contributions: SignalContribution[], score: number): string {
  const parts = contributions.map(
    (entry) =>
      `${entry.signal}(${entry.value.toFixed(2)})×${entry.weight.toFixed(2)}`,
  );
  return `weighted: ${parts.join(' + ')} = ${score.toFixed(4)}`;
}

function validateCandidate(candidate: RankingCandidate): void {
  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
    throw new RankingValidationError('Candidate id must be a non-empty string.');
  }
  for (const [signal, value] of Object.entries(candidate.signals)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RankingValidationError(
        `Candidate "${candidate.id}" has a non-finite value for signal "${signal}".`,
      );
    }
  }
}

// ---- The ranker service ----------------------------------------------

export interface RankingOptions {
  /** Return only the best N results. Omitted = return all, ranked. */
  limit?: number;
}

export interface KnowledgeRankerDiagnostics {
  /** Which strategy this ranker runs. */
  strategy: string;
  totalRankings: number;
  totalCandidates: number;
  failures: number;
}

export interface KnowledgeRanker {
  rank(
    query: string,
    candidates: RankingCandidate[],
    options?: RankingOptions,
  ): Promise<RankedResult[]>;
  getDiagnostics(): KnowledgeRankerDiagnostics;
}

export function createKnowledgeRanker(strategy: RankingStrategy): KnowledgeRanker {
  let totalRankings = 0;
  let totalCandidates = 0;
  let failures = 0;

  return {
    async rank(query, candidates, options = {}) {
      totalRankings++;

      if (typeof query !== 'string' || query.trim() === '') {
        throw new RankingValidationError(
          'Cannot rank with an empty query. Provide a non-empty string.',
        );
      }
      if (!Array.isArray(candidates)) {
        throw new RankingValidationError('candidates must be an array.');
      }
      if (
        options.limit !== undefined &&
        (!Number.isInteger(options.limit) || options.limit < 1)
      ) {
        throw new RankingValidationError('limit must be a positive integer.');
      }

      totalCandidates += candidates.length;

      if (candidates.length === 0) {
        return [];
      }

      let scored: ScoredCandidate[];
      try {
        scored = await strategy.score(query, candidates);
      } catch (error) {
        failures++;
        if (error instanceof RankingError) {
          throw error;
        }
        throw new RankingStrategyError(
          strategy.name,
          error instanceof Error ? error.message : String(error),
        );
      }

      // Never trust strategy output blindly: one score per candidate.
      if (scored.length !== candidates.length) {
        failures++;
        throw new RankingStrategyError(
          strategy.name,
          `returned ${scored.length} scores for ${candidates.length} candidates`,
        );
      }

      const sorted = [...scored].sort(
        (a, b) =>
          b.score - a.score ||
          // Deterministic tiebreaker so equal scores always rank the same.
          a.candidate.id.localeCompare(b.candidate.id),
      );

      const limited =
        options.limit !== undefined ? sorted.slice(0, options.limit) : sorted;

      return limited.map((entry, index) => ({ ...entry, rank: index + 1 }));
    },

    getDiagnostics() {
      return {
        strategy: strategy.name,
        totalRankings,
        totalCandidates,
        failures,
      };
    },
  };
}

// ---- Hybrid retrieval adapter ----------------------------------------

/** Turn hybrid retrieval results into ranking candidates: the per-source
 *  normalized scores become the named signals the ranker weighs. */
export function candidatesFromHybridResults(
  results: HybridRetrievalResult[],
): RankingCandidate[] {
  return results.map((result) => {
    const candidate: RankingCandidate = {
      id: result.id,
      text: result.text,
      signals: {
        keyword: result.keywordScore,
        vector: result.vectorScore,
      },
    };
    if (result.title !== undefined) {
      candidate.title = result.title;
    }
    return candidate;
  });
}
