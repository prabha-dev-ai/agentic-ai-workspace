// The streaming API surface. Consumers import from this barrel only — the
// individual files are implementation layout.

export { StreamError } from './StreamError.ts';
export { StreamState, isTerminal } from './StreamState.ts';
export type { StreamEvent, StreamListener, Unsubscribe } from './StreamEvent.ts';
export type { Stream } from './Stream.ts';
export { StreamManager } from './StreamManager.ts';
export type {
  StreamObserver,
  StreamManagerOptions,
  StreamManagerDiagnostics,
} from './StreamManager.ts';
