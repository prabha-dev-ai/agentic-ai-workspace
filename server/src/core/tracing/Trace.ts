import type { SpanData } from './Span.ts';

// One trace: every span that shares a traceId, assembled as spans finish.
// rootSpanId is the span with no parentSpanId — spans can finish in any
// order, so it stays undefined until that span closes.
export interface Trace {
  traceId: string;
  spans: SpanData[];
  rootSpanId: string | undefined;
  startTime: Date;
  endTime: Date | undefined;
  durationMs: number | undefined;
}
