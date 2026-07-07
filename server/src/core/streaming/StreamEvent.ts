// What a stream emits, as a discriminated union: a consumer switching on
// `type` gets the exact fields for that moment — a 'chunk' carries data
// and a sequence number, the three terminal events carry the final
// chunkCount/durationMs instead. Mixing these behind optional properties
// would let a consumer read the wrong shape for the type without a type
// error (same rationale as MetricSnapshot's union).
export type StreamEvent<T = unknown> =
  | {
      type: 'chunk';
      streamId: string;
      streamName: string;
      sequence: number;
      data: T;
      timestamp: Date;
    }
  | {
      type: 'completed';
      streamId: string;
      streamName: string;
      chunkCount: number;
      durationMs: number;
      timestamp: Date;
    }
  | {
      type: 'error';
      streamId: string;
      streamName: string;
      error: string;
      chunkCount: number;
      durationMs: number;
      timestamp: Date;
    }
  | {
      type: 'cancelled';
      streamId: string;
      streamName: string;
      chunkCount: number;
      durationMs: number;
      timestamp: Date;
    };

export type StreamListener<T = unknown> = (event: StreamEvent<T>) => void;

/** Call to stop receiving events from the stream you subscribed to. */
export type Unsubscribe = () => void;
