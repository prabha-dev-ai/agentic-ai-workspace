import { labelsKey } from './Metric.ts';
import type { MetricLabels } from './Metric.ts';
import type { MetricSample } from './MetricSnapshot.ts';

// A value that can move in either direction: queue depth, active agents,
// memory usage. Each distinct label combination is its own time series.
export class Gauge {
  readonly name: string;
  readonly help: string | undefined;
  private readonly series = new Map<string, MetricSample>();

  constructor(name: string, help?: string) {
    this.name = name;
    this.help = help;
  }

  set(value: number, labels: MetricLabels = {}): void {
    this.series.set(labelsKey(labels), { labels, value });
  }

  inc(amount = 1, labels: MetricLabels = {}): void {
    const key = labelsKey(labels);
    const existing = this.series.get(key);
    this.series.set(key, { labels, value: (existing?.value ?? 0) + amount });
  }

  dec(amount = 1, labels: MetricLabels = {}): void {
    this.inc(-amount, labels);
  }

  /** Every time series this gauge currently tracks. */
  collect(): MetricSample[] {
    return [...this.series.values()].map((sample) => ({ ...sample }));
  }
}
