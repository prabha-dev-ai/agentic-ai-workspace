// The three instrument kinds. A const-object union instead of a TS enum:
// Node's type stripping cannot run enums (same pattern as LogLevel and
// SpanStatus).
export const MetricType = {
  Counter: 'counter',
  Gauge: 'gauge',
  Histogram: 'histogram',
} as const;

export type MetricType = (typeof MetricType)[keyof typeof MetricType];
