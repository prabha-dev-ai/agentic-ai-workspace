// Typed embedding errors: callers distinguish "you sent bad input"
// (validation) from "the provider misbehaved" (provider) by instanceof.

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class EmbeddingValidationError extends EmbeddingError {}

export class EmbeddingProviderError extends EmbeddingError {
  readonly model: string;

  constructor(model: string, reason: string) {
    super(`Embedding provider "${model}" failed: ${reason}`);
    this.model = model;
  }
}
