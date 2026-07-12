import { MetricType } from '../core/metrics/index.ts';
import type { MetricSnapshot } from '../core/metrics/index.ts';

// Prometheus text exposition format (0.0.4) — hand-rolled rather than a
// client library dependency, since MetricsRegistry.export() already gives
// us the exact snapshot shape a formatter needs (see ADR precedent:
// ConsoleMetricExporter does the same "no library needed" formatting for
// stdout). One counter/gauge sample per line; a histogram sample expands
// into its cumulative _bucket lines plus _sum/_count, the Prometheus
// convention MetricSnapshot.ts's doc comments already describe.
export function formatPrometheusText(snapshots: MetricSnapshot[]): string {
  const lines: string[] = [];

  for (const snapshot of snapshots) {
    if (snapshot.help) {
      lines.push(`# HELP ${snapshot.name} ${escapeHelp(snapshot.help)}`);
    }
    lines.push(`# TYPE ${snapshot.name} ${snapshot.type}`);

    if (snapshot.type === MetricType.Histogram) {
      for (const sample of snapshot.samples) {
        for (const bucket of sample.buckets) {
          lines.push(
            `${snapshot.name}_bucket${formatLabels({ ...sample.labels, le: String(bucket.le) })} ${bucket.count}`,
          );
        }
        lines.push(`${snapshot.name}_sum${formatLabels(sample.labels)} ${sample.sum}`);
        lines.push(`${snapshot.name}_count${formatLabels(sample.labels)} ${sample.count}`);
      }
    } else {
      for (const sample of snapshot.samples) {
        lines.push(`${snapshot.name}${formatLabels(sample.labels)} ${sample.value}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) {
    return '';
  }
  return `{${keys.map((key) => `${key}="${escapeLabelValue(labels[key]!)}"`).join(',')}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function escapeHelp(help: string): string {
  return help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}
