export class MetricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Dimensions a data point is recorded under: 'route', 'status', 'agent'. */
export type MetricLabels = Record<string, string>;

/**
 * A stable string key for a label set: same labels serialize identically
 * regardless of insertion order, so repeated calls with the same values
 * accumulate into the same time series instead of silently forking one.
 */
export function labelsKey(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(',');
}
