import { randomUUID } from 'node:crypto';
import { StreamError } from './StreamError.ts';
import { StreamState, isTerminal } from './StreamState.ts';
import type { Stream } from './Stream.ts';
import type { StreamEvent, StreamListener } from './StreamEvent.ts';
import { EventType } from '../events/EventType.ts';
import type { EventBus } from '../events/EventBus.ts';

export interface StreamObserver {
  readonly name: string;
  onEvent(event: StreamEvent): void;
}

export interface StreamManagerOptions {
  /** Streams retained for getStream()/listStreams(); oldest evicted first. Default 1000. */
  maxStreams?: number;
}

export interface StreamManagerDiagnostics {
  /** Every stream ever created — a historical total, unaffected by retention eviction. */
  totalStreams: number;
  /** Streams not yet in a terminal state (pending or active). */
  activeStreams: number;
  completedStreams: number;
  failedStreams: number;
  cancelledStreams: number;
  totalChunks: number;
  /** Registered observer names, in registration order. */
  observers: string[];
  /** Observer onEvent() throws — isolated, counted, never propagated. */
  observerFailures: number;
}

// The streaming hub: components ask it to create a stream (a producer
// pushes chunks, consumers subscribe to it directly), and it fans every
// stream's events out to a set of global observers — the same
// fan-out-with-isolation destination model as sinks/exporters. Lifecycle
// milestones (started/completed/failed/cancelled) are also published onto
// the framework's shared event bus, when connected; individual chunks are
// not — chunk volume is per-stream detail, not framework-wide milestone
// traffic (same reasoning as ObservabilityService logging event traffic
// at debug, not info).
export class StreamManager {
  private readonly streams = new Map<string, Stream>();
  private readonly streamOrder: string[] = [];
  private readonly observers = new Map<string, StreamObserver>();
  private readonly maxStreams: number;
  private eventBus: EventBus | undefined;

  private totalStreams = 0;
  private totalChunks = 0;
  private completedCount = 0;
  private failedCount = 0;
  private cancelledCount = 0;
  private observerFailures = 0;

  constructor(options: StreamManagerOptions = {}) {
    this.maxStreams = options.maxStreams ?? 1000;
  }

  /** Register a global observer. Duplicate names fail loudly — silent
   *  replacement is how "where did my stream events go?" bugs are born. */
  addObserver(observer: StreamObserver): void {
    if (typeof observer.name !== 'string' || observer.name.trim() === '') {
      throw new StreamError('A stream observer needs a non-empty name.');
    }
    if (this.observers.has(observer.name)) {
      throw new StreamError(`A stream observer named "${observer.name}" is already registered.`);
    }
    this.observers.set(observer.name, observer);
  }

  removeObserver(name: string): void {
    if (!this.observers.delete(name)) {
      throw new StreamError(`No stream observer named "${name}" is registered.`);
    }
  }

  /** Publish stream lifecycle milestones (not chunks) onto the framework
   *  event bus, correlated by stream id. */
  connectEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  createStream<T = unknown>(name: string): Stream<T> {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new StreamError('A stream needs a non-empty name.');
    }

    const id = randomUUID();
    const startedAt = new Date();
    const manager = this;
    const listeners = new Set<StreamListener<T>>();

    let state: StreamState = StreamState.Pending;
    let chunkCount = 0;
    let sequence = 0;

    const durationMs = () => Date.now() - startedAt.getTime();

    const ensureOpen = () => {
      if (isTerminal(state)) {
        throw new StreamError(`Stream "${id}" ("${name}") is already ${state} and cannot be modified.`);
      }
    };

    const dispatch = (event: StreamEvent<T>) => {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // A throwing subscriber must never break the producer or the
          // other subscribers — same isolation philosophy as EventBus.
        }
      }
      manager.notifyObservers(event);
    };

    const stream: Stream<T> = {
      id,
      name,
      get state() {
        return state;
      },
      get chunkCount() {
        return chunkCount;
      },
      startedAt,

      push(data) {
        ensureOpen();
        if (state === StreamState.Pending) {
          state = StreamState.Active;
          manager.publishLifecycle(EventType.StreamStarted, id, name);
        }

        chunkCount++;
        manager.totalChunks++;
        dispatch({
          type: 'chunk',
          streamId: id,
          streamName: name,
          sequence: sequence++,
          data,
          timestamp: new Date(),
        });
      },

      complete() {
        ensureOpen();
        state = StreamState.Completed;
        manager.completedCount++;
        dispatch({
          type: 'completed',
          streamId: id,
          streamName: name,
          chunkCount,
          durationMs: durationMs(),
          timestamp: new Date(),
        });
        manager.publishLifecycle(EventType.StreamCompleted, id, name);
      },

      fail(error) {
        ensureOpen();
        state = StreamState.Error;
        manager.failedCount++;
        dispatch({
          type: 'error',
          streamId: id,
          streamName: name,
          error,
          chunkCount,
          durationMs: durationMs(),
          timestamp: new Date(),
        });
        manager.publishLifecycle(EventType.StreamFailed, id, name, error);
      },

      cancel() {
        ensureOpen();
        state = StreamState.Cancelled;
        manager.cancelledCount++;
        dispatch({
          type: 'cancelled',
          streamId: id,
          streamName: name,
          chunkCount,
          durationMs: durationMs(),
          timestamp: new Date(),
        });
        manager.publishLifecycle(EventType.StreamCancelled, id, name);
      },

      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    this.totalStreams++;
    this.retain(id, stream as Stream);
    return stream;
  }

  getStream(id: string): Stream | undefined {
    return this.streams.get(id);
  }

  /** Every currently-retained stream, oldest first. Subject to maxStreams eviction. */
  listStreams(): Stream[] {
    return this.streamOrder.map((id) => this.streams.get(id)!);
  }

  getDiagnostics(): StreamManagerDiagnostics {
    return {
      totalStreams: this.totalStreams,
      activeStreams: this.totalStreams - this.completedCount - this.failedCount - this.cancelledCount,
      completedStreams: this.completedCount,
      failedStreams: this.failedCount,
      cancelledStreams: this.cancelledCount,
      totalChunks: this.totalChunks,
      observers: [...this.observers.keys()],
      observerFailures: this.observerFailures,
    };
  }

  private retain(id: string, stream: Stream): void {
    this.streams.set(id, stream);
    this.streamOrder.push(id);

    if (this.streamOrder.length > this.maxStreams) {
      const evicted = this.streamOrder.shift();
      if (evicted !== undefined) {
        this.streams.delete(evicted);
      }
    }
  }

  private notifyObservers(event: StreamEvent): void {
    for (const observer of this.observers.values()) {
      try {
        observer.onEvent(event);
      } catch {
        this.observerFailures++;
      }
    }
  }

  private publishLifecycle(type: EventType, streamId: string, streamName: string, error?: string): void {
    if (!this.eventBus) {
      return;
    }
    this.eventBus.publish({
      type,
      source: 'stream-manager',
      correlationId: streamId,
      payload: error !== undefined ? { streamName, error } : { streamName },
    });
  }
}
