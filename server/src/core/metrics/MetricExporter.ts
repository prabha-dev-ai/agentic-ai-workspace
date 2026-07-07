import type { MetricSnapshot } from './MetricSnapshot.ts';

// Where a metrics snapshot goes. Unlike LogSink/SpanExporter — which
// receive one entry the instant it happens — a metric exporter receives
// the whole registry's current snapshot on demand: metrics are mutated
// continuously (a counter has no "finish" event), so *when* to read them
// is a scrape/flush decision the caller makes (an HTTP handler, a
// periodic job), not something the registry can know on its own.
export interface MetricExporter {
  readonly name: string;
  export(snapshot: MetricSnapshot[]): void;
}

// The default exporter: one JSON line per metric in the snapshot.
export class ConsoleMetricExporter implements MetricExporter {
  readonly name = 'console';

  export(snapshot: MetricSnapshot[]): void {
    for (const metric of snapshot) {
      console.log(JSON.stringify(metric));
    }
  }
}

// An in-memory exporter for tests and short-lived inspection — the
// metrics equivalent of MemoryLogSink / InMemorySpanExporter.
export class InMemoryMetricExporter implements MetricExporter {
  readonly name: string;
  readonly exports: MetricSnapshot[][] = [];

  constructor(name = 'memory') {
    this.name = name;
  }

  export(snapshot: MetricSnapshot[]): void {
    this.exports.push(snapshot);
  }

  clear(): void {
    this.exports.length = 0;
  }
}
