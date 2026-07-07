// The propagate-able identity of a span: just enough to parent new spans
// onto it from anywhere — across a function call, an async boundary, a
// plugin, a queued job. Unlike the Logger's correlationId (bound once,
// inherited implicitly by child()), a TraceContext is a plain value the
// caller reads off a span with span.context() and passes explicitly to
// whatever it calls next as `{ parent: context }`.
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
}
