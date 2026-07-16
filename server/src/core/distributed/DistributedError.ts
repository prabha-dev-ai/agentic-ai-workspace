// Typed error for the distributed-execution layer, the same discipline
// as CheckpointError: callers can `instanceof DistributedError` instead
// of string-matching messages.
export class DistributedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DistributedError';
  }
}
