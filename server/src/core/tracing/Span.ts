import type { SpanStatus } from './SpanStatus.ts';
import type { TraceContext } from './TraceContext.ts';

/** Structured context attached to a span — data, never prose. */
export type SpanAttributes = Record<string, string | number | boolean>;

// One finished span: a named, timed unit of work, positioned in its trace
// by parentSpanId. This is the record exporters and diagnostics see — the
// immutable other half of the mutable Span handle a component holds while
// the work is in flight.
export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  /** What was done: 'plan.create', 'tool.execute', 'llm.completion'. */
  name: string;
  /** Who did it, dot-namespaced — same convention as Logger.component. */
  component: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  status: SpanStatus;
  attributes: SpanAttributes;
  error: string | undefined;
}

// The component-facing handle to a span in flight. Ending is the one
// mutation a span allows — everything else about it (identity, parentage,
// name, component) is fixed at start and read-only thereafter.
export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly component: string;
  readonly startTime: Date;

  setAttribute(key: string, value: string | number | boolean): void;
  setAttributes(attributes: SpanAttributes): void;

  /** This span's propagate-able identity — pass as `parent` to startSpan() downstream. */
  context(): TraceContext;

  /** Start a child span: same trace, parented to this span. */
  startChild(name: string, attributes?: SpanAttributes): Span;

  /**
   * Close the span: records endTime and durationMs automatically, then
   * dispatches to every registered exporter. Ending an already-ended span
   * throws — a span that could be silently re-ended is a timing bug
   * waiting to happen.
   */
  end(status?: SpanStatus, error?: string): void;
}
