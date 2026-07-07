import type { Span, SpanAttributes } from './Span.ts';
import type { TraceContext } from './TraceContext.ts';

export interface StartSpanOptions {
  /** Context to parent this span under — omit to start a new trace. */
  parent?: TraceContext;
  attributes?: SpanAttributes;
}

// The component-facing tracing surface. Tracers are cheap, immutable
// views onto the TracingService: child() narrows the component — the same
// shape as Logger.child() — and neither call mutates the parent tracer.
export interface Tracer {
  readonly component: string;

  startSpan(name: string, options?: StartSpanOptions): Span;

  /**
   * Run fn inside a span: start, execute, end — automatically, even if fn
   * throws. A throw is recorded as SpanStatus.Error with the error message
   * before it rethrows, so failures are timed and diagnosed like every
   * other span.
   */
  withSpan<T>(name: string, fn: (span: Span) => T, options?: StartSpanOptions): T;
  withSpanAsync<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    options?: StartSpanOptions,
  ): Promise<T>;

  /** A tracer for a sub-component: 'planner' -> 'planner.llm'. */
  child(subComponent: string): Tracer;
}
