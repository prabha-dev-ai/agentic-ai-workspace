import { MetricError, labelsKey } from './Metric.ts';
import type { MetricLabels } from './Metric.ts';
import type { HistogramSample } from './MetricSnapshot.ts';

/** Millisecond-scale default buckets — fits durationMs from tracing spans. */
export const DEFAULT_HISTOGRAM_BUCKETS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
];

interface HistogramState {
  labels: MetricLabels;
  count: number;
  sum: number;
  /** Cumulative per-boundary counts, parallel to `boundaries`. */
  bucketCounts: number[];
}

// A distribution of observed values — request latency, payload size —
// bucketed cumulatively (Prometheus convention: a bucket's count includes
// every observation <= its boundary). Each distinct label combination is
// its own time series.
export class Histogram {
  readonly name: string;
  readonly help: string | undefined;
  private readonly boundaries: number[];
  private readonly series = new Map<string, HistogramState>();

  constructor(name: string, help?: string, buckets: number[] = DEFAULT_HISTOGRAM_BUCKETS) {
    if (buckets.length === 0) {
      throw new MetricError(`Histogram "${name}" needs at least one bucket boundary.`);
    }

    this.name = name;
    this.help = help;
    this.boundaries = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels: MetricLabels = {}): void {
    const key = labelsKey(labels);
    let state = this.series.get(key);

    if (!state) {
      state = {
        labels,
        count: 0,
        sum: 0,
        bucketCounts: this.boundaries.map(() => 0),
      };
      this.series.set(key, state);
    }

    state.count++;
    state.sum += value;

    for (let i = 0; i < this.boundaries.length; i++) {
      if (value <= this.boundaries[i]!) {
        state.bucketCounts[i]!++;
      }
    }
  }

  /** Every time series this histogram currently tracks. */
  collect(): HistogramSample[] {
    return [...this.series.values()].map((state) => ({
      labels: state.labels,
      count: state.count,
      sum: state.sum,
      buckets: this.boundaries.map((le, i) => ({ le, count: state.bucketCounts[i]! })),
    }));
  }
}
