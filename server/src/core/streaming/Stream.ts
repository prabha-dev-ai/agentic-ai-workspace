import type { StreamState } from './StreamState.ts';
import type { StreamListener, Unsubscribe } from './StreamEvent.ts';

// The stream abstraction: a named, timed sequence of chunks that ends in
// exactly one terminal state. One object plays both roles — the producer
// pushes chunks and closes the stream, consumers subscribe to watch it —
// the same shape Span uses for a single span's writer/reader split.
export interface Stream<T = unknown> {
  readonly id: string;
  readonly name: string;
  readonly state: StreamState;
  readonly chunkCount: number;
  readonly startedAt: Date;

  /** Push the next chunk. Throws once the stream has reached a terminal state. */
  push(data: T): void;

  /** Close the stream successfully. Throws if already terminal. */
  complete(): void;

  /** Close the stream with an error. Throws if already terminal. */
  fail(error: string): void;

  /** Close the stream as cancelled (the consumer walked away). Throws if already terminal. */
  cancel(): void;

  /** Watch every event this stream emits from now on. Returns an unsubscribe function. */
  subscribe(listener: StreamListener<T>): Unsubscribe;
}
