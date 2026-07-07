import { MetricError, labelsKey } from './Metric.ts';
import type { MetricLabels } from './Metric.ts';
import type { MetricSample } from './MetricSnapshot.ts';

// A monotonically increasing value: requests served, tasks completed,
// errors seen. Each distinct label combination is its own time series,
// tracked internally by a stable label key.
export class Counter {
  readonly name: string;
  readonly help: string | undefined;
  private readonly series = new Map<string, MetricSample>();

  constructor(name: string, help?: string) {
    this.name = name;
    this.help = help;
  }

  /** Increase the counter. Negative amounts throw — a counter never goes down. */
  inc(amount = 1, labels: MetricLabels = {}): void {
    if (amount < 0) {
      throw new MetricError(
        `Counter "${this.name}" cannot be incremented by a negative amount (${amount}).`,
      );
    }

    const key = labelsKey(labels);
    const existing = this.series.get(key);

    if (existing) {
      existing.value += amount;
    } else {
      this.series.set(key, { labels, value: amount });
    }
  }

  /** Every time series this counter currently tracks. */
  collect(): MetricSample[] {
    return [...this.series.values()].map((sample) => ({ ...sample }));
  }
}
