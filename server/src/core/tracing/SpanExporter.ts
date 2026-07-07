import type { SpanData } from './Span.ts';

// Where finished spans go. The service fans every finished span out to
// all exporters; plugins contribute additional exporters (collectors,
// files, tracing backends) through the span-exporter-provider capability
// — the tracing mirror of LogSink / log-sink-provider.
export interface SpanExporter {
  readonly name: string;
  export(span: SpanData): void;
}

// The default exporter: one JSON line per finished span. Machine-
// parseable, same rationale as ConsoleLogSink.
export class ConsoleSpanExporter implements SpanExporter {
  readonly name = 'console';

  export(span: SpanData): void {
    const line = JSON.stringify({
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      component: span.component,
      startTime: span.startTime.toISOString(),
      endTime: span.endTime.toISOString(),
      durationMs: span.durationMs,
      status: span.status,
      ...(Object.keys(span.attributes).length > 0 && { attributes: span.attributes }),
      ...(span.error !== undefined && { error: span.error }),
    });

    if (span.status === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}

// An in-memory exporter for tests and short-lived inspection — the trace
// equivalent of MemoryLogSink.
export class InMemorySpanExporter implements SpanExporter {
  readonly name: string;
  readonly spans: SpanData[] = [];

  constructor(name = 'memory') {
    this.name = name;
  }

  export(span: SpanData): void {
    this.spans.push(span);
  }

  clear(): void {
    this.spans.length = 0;
  }
}
