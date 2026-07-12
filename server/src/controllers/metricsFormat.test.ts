import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsRegistry } from '../core/metrics/index.ts';
import { formatPrometheusText } from './metricsFormat.ts';

describe('formatPrometheusText', () => {
  test('formats a counter as HELP/TYPE/value lines', () => {
    const metrics = new MetricsRegistry();
    metrics.counter('requests_total', 'Total requests.').inc(3, { route: '/chat' });

    const text = formatPrometheusText(metrics.collect());

    assert.match(text, /# HELP requests_total Total requests\.\n/);
    assert.match(text, /# TYPE requests_total counter\n/);
    assert.match(text, /requests_total\{route="\/chat"\} 3\n/);
  });

  test('formats a gauge with no labels', () => {
    const metrics = new MetricsRegistry();
    metrics.gauge('active_agents').set(5);

    const text = formatPrometheusText(metrics.collect());

    assert.match(text, /# TYPE active_agents gauge\n/);
    assert.match(text, /active_agents 5\n/);
  });

  test('expands a histogram into cumulative _bucket lines plus _sum/_count', () => {
    const metrics = new MetricsRegistry();
    const histogram = metrics.histogram('duration_ms', undefined, [10, 50]);
    histogram.observe(5);
    histogram.observe(20);

    const text = formatPrometheusText(metrics.collect());

    assert.match(text, /duration_ms_bucket\{le="10"\} 1\n/);
    assert.match(text, /duration_ms_bucket\{le="50"\} 2\n/);
    assert.match(text, /duration_ms_sum 25\n/);
    assert.match(text, /duration_ms_count 2\n/);
  });

  test('escapes quotes and backslashes in label values', () => {
    const metrics = new MetricsRegistry();
    metrics.counter('errors_total').inc(1, { message: 'a "quoted" \\ value' });

    const text = formatPrometheusText(metrics.collect());

    assert.match(text, /message="a \\"quoted\\" \\\\ value"/);
  });
});
