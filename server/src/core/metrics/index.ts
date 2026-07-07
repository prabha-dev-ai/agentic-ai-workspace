// The metrics API surface. Consumers import from this barrel only — the
// individual files are implementation layout.

export { MetricType } from './MetricType.ts';
export { MetricError, labelsKey } from './Metric.ts';
export type { MetricLabels } from './Metric.ts';
export type {
  MetricSample,
  HistogramBucketSample,
  HistogramSample,
  MetricSnapshot,
} from './MetricSnapshot.ts';
export { Counter } from './Counter.ts';
export { Gauge } from './Gauge.ts';
export { Histogram, DEFAULT_HISTOGRAM_BUCKETS } from './Histogram.ts';
export type { MetricExporter } from './MetricExporter.ts';
export { ConsoleMetricExporter, InMemoryMetricExporter } from './MetricExporter.ts';
export { MetricsRegistry } from './MetricsRegistry.ts';
export type { MetricsRegistryDiagnostics } from './MetricsRegistry.ts';
