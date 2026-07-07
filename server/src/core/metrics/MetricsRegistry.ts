import { MetricError } from './Metric.ts';
import { MetricType } from './MetricType.ts';
import { Counter } from './Counter.ts';
import { Gauge } from './Gauge.ts';
import { Histogram, DEFAULT_HISTOGRAM_BUCKETS } from './Histogram.ts';
import type { MetricExporter } from './MetricExporter.ts';
import type { MetricSnapshot } from './MetricSnapshot.ts';

type Instrument = Counter | Gauge | Histogram;

interface RegisteredMetric {
  type: MetricType;
  instrument: Instrument;
}

export interface MetricsRegistryDiagnostics {
  countersRegistered: number;
  gaugesRegistered: number;
  histogramsRegistered: number;
  /** Registered exporter names, in registration order. */
  exporters: string[];
  /** Exporter export() throws — isolated, counted, never propagated. */
  exporterFailures: number;
  /** How many times export() has been called (i.e. scrapes/flushes). */
  exportCount: number;
}

// The metrics hub: components ask it for counters/gauges/histograms by
// name (get-or-create, like Prometheus's client registries), and
// export() pushes the current snapshot to every registered exporter.
// Mirrors ObservabilityService/TraceManager deliberately — same
// fan-out-with-isolation destination model (exporters/sinks), same
// plugin capability shape for contributed destinations. The difference
// is the read model: logs and spans are dispatched once, at the instant
// they happen; metrics are mutated continuously and only read on demand.
export class MetricsRegistry {
  private readonly metrics = new Map<string, RegisteredMetric>();
  private readonly exporters = new Map<string, MetricExporter>();

  private exporterFailures = 0;
  private exportCount = 0;

  /** Register an exporter. Duplicate names fail loudly — silent replacement
   *  is how "where did my metrics go?" bugs are born. */
  addExporter(exporter: MetricExporter): void {
    if (typeof exporter.name !== 'string' || exporter.name.trim() === '') {
      throw new MetricError('A metric exporter needs a non-empty name.');
    }
    if (this.exporters.has(exporter.name)) {
      throw new MetricError(
        `A metric exporter named "${exporter.name}" is already registered.`,
      );
    }
    this.exporters.set(exporter.name, exporter);
  }

  removeExporter(name: string): void {
    if (!this.exporters.delete(name)) {
      throw new MetricError(`No metric exporter named "${name}" is registered.`);
    }
  }

  /** Get the named counter, creating it on first use. Re-registering under
   *  a different instrument type throws — a name has exactly one shape. */
  counter(name: string, help?: string): Counter {
    return this.getOrCreate(name, MetricType.Counter, () => new Counter(name, help));
  }

  gauge(name: string, help?: string): Gauge {
    return this.getOrCreate(name, MetricType.Gauge, () => new Gauge(name, help));
  }

  histogram(
    name: string,
    help?: string,
    buckets: number[] = DEFAULT_HISTOGRAM_BUCKETS,
  ): Histogram {
    return this.getOrCreate(name, MetricType.Histogram, () => new Histogram(name, help, buckets));
  }

  /** A point-in-time snapshot of every registered metric — no exporter side effects. */
  collect(): MetricSnapshot[] {
    return [...this.metrics.values()].map(({ type, instrument }) => toSnapshot(type, instrument));
  }

  /** Collect the current snapshot and push it to every exporter, isolated
   *  the same way sinks/span exporters are: one broken exporter must
   *  never break the app or starve the other exporters. */
  export(): MetricSnapshot[] {
    const snapshot = this.collect();
    this.exportCount++;

    for (const exporter of this.exporters.values()) {
      try {
        exporter.export(snapshot);
      } catch {
        this.exporterFailures++;
      }
    }

    return snapshot;
  }

  getDiagnostics(): MetricsRegistryDiagnostics {
    let countersRegistered = 0;
    let gaugesRegistered = 0;
    let histogramsRegistered = 0;

    for (const { type } of this.metrics.values()) {
      if (type === MetricType.Counter) countersRegistered++;
      else if (type === MetricType.Gauge) gaugesRegistered++;
      else histogramsRegistered++;
    }

    return {
      countersRegistered,
      gaugesRegistered,
      histogramsRegistered,
      exporters: [...this.exporters.keys()],
      exporterFailures: this.exporterFailures,
      exportCount: this.exportCount,
    };
  }

  private getOrCreate<T extends Instrument>(
    name: string,
    type: MetricType,
    factory: () => T,
  ): T {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new MetricError('A metric needs a non-empty name.');
    }

    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.type !== type) {
        throw new MetricError(
          `Metric "${name}" is already registered as a ${existing.type}, not a ${type}.`,
        );
      }
      return existing.instrument as T;
    }

    const instrument = factory();
    this.metrics.set(name, { type, instrument });
    return instrument;
  }
}

function toSnapshot(type: MetricType, instrument: Instrument): MetricSnapshot {
  if (type === MetricType.Histogram) {
    const histogram = instrument as Histogram;
    return {
      type: MetricType.Histogram,
      name: histogram.name,
      help: histogram.help,
      samples: histogram.collect(),
    };
  }

  const flat = instrument as Counter | Gauge;
  return {
    type: type as typeof MetricType.Counter | typeof MetricType.Gauge,
    name: flat.name,
    help: flat.help,
    samples: flat.collect(),
  };
}
