// The tracing API surface. Consumers import from this barrel only — the
// individual files are implementation layout.

export { SpanStatus } from './SpanStatus.ts';
export type { TraceContext } from './TraceContext.ts';
export type { Span, SpanAttributes, SpanData } from './Span.ts';
export type { Trace } from './Trace.ts';
export type { Tracer, StartSpanOptions } from './Tracer.ts';
export type { SpanExporter } from './SpanExporter.ts';
export { ConsoleSpanExporter, InMemorySpanExporter } from './SpanExporter.ts';
export { TraceError, TraceManager } from './TraceManager.ts';
export type { TraceManagerDiagnostics, TraceManagerOptions } from './TraceManager.ts';
