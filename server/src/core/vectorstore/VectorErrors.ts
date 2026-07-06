// Typed vector store errors: callers distinguish "you sent bad input"
// (validation), "the vector is the wrong shape" (dimension mismatch),
// and "that id does not exist" (not found) by instanceof.

export class VectorStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class VectorValidationError extends VectorStoreError {}

export class DimensionMismatchError extends VectorStoreError {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(`Vector has ${actual} dimensions, expected ${expected}.`);
    this.expected = expected;
    this.actual = actual;
  }
}

export class DocumentNotFoundError extends VectorStoreError {
  readonly id: string;

  constructor(id: string) {
    super(`No document with id "${id}" exists in the vector store.`);
    this.id = id;
  }
}

export class DuplicateDocumentError extends VectorStoreError {
  readonly id: string;

  constructor(id: string) {
    super(`A document with id "${id}" already exists. Use update() to replace it.`);
    this.id = id;
  }
}
