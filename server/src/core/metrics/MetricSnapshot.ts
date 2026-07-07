import type { MetricLabels } from './Metric.ts';
import type { MetricType } from './MetricType.ts';

/** One time series's current value — a counter or gauge data point. */
export interface MetricSample {
  labels: MetricLabels;
  value: number;
}

/** One cumulative bucket: "count of observations <= le" (Prometheus convention). */
export interface HistogramBucketSample {
  le: number;
  count: number;
}

/** One time series's current distribution. */
export interface HistogramSample {
  labels: MetricLabels;
  count: number;
  sum: number;
  buckets: HistogramBucketSample[];
}

// A discriminated union rather than one shape with optional fields: a
// counter/gauge snapshot's samples are flat values, a histogram's are
// distributions — mixing them behind optional properties would let a
// consumer read the wrong shape for the type without a type error.
export type MetricSnapshot =
  | { type: typeof MetricType.Counter; name: string; help: string | undefined; samples: MetricSample[] }
  | { type: typeof MetricType.Gauge; name: string; help: string | undefined; samples: MetricSample[] }
  | { type: typeof MetricType.Histogram; name: string; help: string | undefined; samples: HistogramSample[] };
