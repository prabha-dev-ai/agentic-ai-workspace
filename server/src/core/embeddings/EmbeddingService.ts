import {
  EmbeddingError,
  EmbeddingProviderError,
  EmbeddingValidationError,
} from './EmbeddingErrors.ts';
import type { EmbeddingProvider } from './EmbeddingProvider.ts';
import type { EmbeddingResult } from './EmbeddingResult.ts';

export interface EmbeddingServiceOptions {
  /** Max texts per provider call. Default 16. */
  batchSize?: number;
}

export interface EmbeddingDiagnostics {
  /** embed()/embedBatch() invocations. */
  totalRequests: number;
  /** Individual texts embedded (or attempted). */
  totalTexts: number;
  /** Calls that actually reached the provider (batches count once). */
  providerCalls: number;
  failures: number;
}

// The service layer over any EmbeddingProvider: validate before spending
// API calls, chunk large batches, and never let a malformed vector out —
// everything downstream (stores, similarity) trusts EmbeddingResult.
export class EmbeddingService {
  private readonly provider: EmbeddingProvider;
  private readonly batchSize: number;

  private totalRequests = 0;
  private totalTexts = 0;
  private providerCalls = 0;
  private failures = 0;

  constructor(provider: EmbeddingProvider, options: EmbeddingServiceOptions = {}) {
    if (options.batchSize !== undefined && options.batchSize < 1) {
      throw new EmbeddingValidationError('batchSize must be at least 1.');
    }

    this.provider = provider;
    this.batchSize = options.batchSize ?? 16;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    this.totalRequests++;
    this.validateText(text);
    this.totalTexts++;

    const vector = await this.callProvider(() => this.provider.embed(text));

    return this.normalize(text, vector);
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    this.totalRequests++;

    if (!Array.isArray(texts) || texts.length === 0) {
      throw new EmbeddingValidationError('embedBatch needs at least one text.');
    }

    // Validate EVERYTHING before the first provider call: a bad text at
    // position 40 must not waste the API spend on positions 0-39.
    for (const text of texts) {
      this.validateText(text);
    }

    this.totalTexts += texts.length;

    const results: EmbeddingResult[] = [];

    for (let start = 0; start < texts.length; start += this.batchSize) {
      const chunk = texts.slice(start, start + this.batchSize);
      const vectors = await this.callProvider(() => this.provider.embedBatch(chunk));

      if (vectors.length !== chunk.length) {
        this.failures++;
        throw new EmbeddingProviderError(
          this.provider.model.name,
          `returned ${vectors.length} vectors for ${chunk.length} texts`,
        );
      }

      chunk.forEach((text, index) => {
        results.push(this.normalize(text, vectors[index] ?? []));
      });
    }

    return results;
  }

  getDiagnostics(): EmbeddingDiagnostics {
    return {
      totalRequests: this.totalRequests,
      totalTexts: this.totalTexts,
      providerCalls: this.providerCalls,
      failures: this.failures,
    };
  }

  private validateText(text: string): void {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new EmbeddingValidationError(
        'Cannot embed an empty text. Provide a non-empty string.',
      );
    }
  }

  private async callProvider<T>(call: () => Promise<T>): Promise<T> {
    this.providerCalls++;

    try {
      return await call();
    } catch (error) {
      this.failures++;

      if (error instanceof EmbeddingError) {
        throw error;
      }

      throw new EmbeddingProviderError(
        this.provider.model.name,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Never trust provider output: vectors must be non-empty, finite, and
  // match the model's declared dimensions.
  private normalize(text: string, vector: number[]): EmbeddingResult {
    if (!Array.isArray(vector) || vector.length === 0) {
      this.failures++;
      throw new EmbeddingProviderError(this.provider.model.name, 'returned an empty vector');
    }

    if (!vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      this.failures++;
      throw new EmbeddingProviderError(
        this.provider.model.name,
        'returned a vector with non-numeric values',
      );
    }

    const expected = this.provider.model.dimensions;
    if (expected !== undefined && vector.length !== expected) {
      this.failures++;
      throw new EmbeddingProviderError(
        this.provider.model.name,
        `returned ${vector.length} dimensions, expected ${expected}`,
      );
    }

    return {
      text,
      vector,
      model: this.provider.model.name,
      dimensions: vector.length,
    };
  }
}
