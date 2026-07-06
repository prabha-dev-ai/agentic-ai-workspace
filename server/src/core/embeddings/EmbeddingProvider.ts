import { DEFAULT_EMBEDDING_MODEL } from './EmbeddingModel.ts';
import { EmbeddingProviderError } from './EmbeddingErrors.ts';
import type OpenAI from 'openai';
import type { EmbeddingModel } from './EmbeddingModel.ts';

// The provider abstraction: raw text -> raw vectors. Providers know how
// to talk to one backend; the EmbeddingService owns validation, batching
// and normalization on top of ANY provider.
export interface EmbeddingProvider {
  readonly model: EmbeddingModel;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

// The default provider: any OpenAI-compatible /embeddings endpoint. The
// client is injected — the container remains the only construction site.
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: EmbeddingModel;
  private readonly client: OpenAI;

  constructor(client: OpenAI, model: EmbeddingModel = DEFAULT_EMBEDDING_MODEL) {
    this.client = client;
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model.name,
      input: text,
    });

    const vector = response.data[0]?.embedding;

    if (!vector) {
      throw new EmbeddingProviderError(this.model.name, 'response contained no embedding');
    }

    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model.name,
      input: texts,
    });

    // The API is not required to preserve order — the index field is.
    const ordered = [...response.data].sort((a, b) => a.index - b.index);

    if (ordered.length !== texts.length) {
      throw new EmbeddingProviderError(
        this.model.name,
        `expected ${texts.length} embeddings, received ${ordered.length}`,
      );
    }

    return ordered.map((entry) => entry.embedding);
  }
}
