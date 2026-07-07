import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsRegistry } from './MetricsRegistry.ts';
import { MetricError } from './Metric.ts';
import { Counter } from './Counter.ts';
import { Gauge } from './Gauge.ts';
import { Histogram, DEFAULT_HISTOGRAM_BUCKETS } from './Histogram.ts';
import { ConsoleMetricExporter, InMemoryMetricExporter } from './MetricExporter.ts';
import { MetricType } from './MetricType.ts';
import { PluginLoader, PluginRegistry, PluginCapability } from '../plugins/index.ts';
import type { AgentPlugin, MetricExporterProvider } from '../plugins/index.ts';
import type { MetricExporter } from './MetricExporter.ts';

describe('Counter', () => {
  test('defaults to incrementing by 1 with no labels', () => {
    const counter = new Counter('requests_total');
    counter.inc();
    counter.inc();

    assert.deepEqual(counter.collect(), [{ labels: {}, value: 2 }]);
  });

  test('accepts an explicit amount', () => {
    const counter = new Counter('items_total');
    counter.inc(5);

    assert.equal(counter.collect()[0]?.value, 5);
  });

  test('negative amounts are rejected', () => {
    const counter = new Counter('requests_total');
    assert.throws(() => counter.inc(-1), MetricError);
  });

  test('distinct label sets are distinct time series', () => {
    const counter = new Counter('requests_total');
    counter.inc(1, { route: '/a' });
    counter.inc(1, { route: '/a' });
    counter.inc(1, { route: '/b' });

    const samples = counter.collect().sort((a, b) => a.labels.route!.localeCompare(b.labels.route!));
    assert.deepEqual(samples, [
      { labels: { route: '/a' }, value: 2 },
      { labels: { route: '/b' }, value: 1 },
    ]);
  });

  test('label key order does not fork the time series', () => {
    const counter = new Counter('requests_total');
    counter.inc(1, { route: '/a', method: 'GET' });
    counter.inc(1, { method: 'GET', route: '/a' });

    assert.equal(counter.collect().length, 1);
    assert.equal(counter.collect()[0]?.value, 2);
  });
});

describe('Gauge', () => {
  test('set overwrites the current value', () => {
    const gauge = new Gauge('queue_depth');
    gauge.set(3);
    gauge.set(7);

    assert.equal(gauge.collect()[0]?.value, 7);
  });

  test('inc and dec move the value in either direction', () => {
    const gauge = new Gauge('active_agents');
    gauge.inc();
    gauge.inc(2);
    gauge.dec(1);

    assert.equal(gauge.collect()[0]?.value, 2);
  });

  test('inc without a prior set starts from zero', () => {
    const gauge = new Gauge('active_agents');
    gauge.inc(5);

    assert.equal(gauge.collect()[0]?.value, 5);
  });

  test('distinct label sets are distinct time series', () => {
    const gauge = new Gauge('queue_depth');
    gauge.set(1, { queue: 'high' });
    gauge.set(2, { queue: 'low' });

    assert.equal(gauge.collect().length, 2);
  });
});

describe('Histogram', () => {
  test('observations accumulate cumulatively into the smallest matching buckets and beyond', () => {
    const histogram = new Histogram('latency_ms', undefined, [10, 50, 100]);
    histogram.observe(5);
    histogram.observe(20);
    histogram.observe(200);

    const [sample] = histogram.collect();
    assert.equal(sample?.count, 3);
    assert.equal(sample?.sum, 225);
    assert.deepEqual(sample?.buckets, [
      { le: 10, count: 1 },
      { le: 50, count: 2 },
      { le: 100, count: 2 },
    ]);
  });

  test('bucket boundaries are sorted regardless of constructor order', () => {
    const histogram = new Histogram('latency_ms', undefined, [100, 10, 50]);
    histogram.observe(30);

    assert.deepEqual(
      histogram.collect()[0]?.buckets.map((b) => b.le),
      [10, 50, 100],
    );
  });

  test('defaults to DEFAULT_HISTOGRAM_BUCKETS when none are given', () => {
    const histogram = new Histogram('latency_ms');
    histogram.observe(1);

    assert.deepEqual(
      histogram.collect()[0]?.buckets.map((b) => b.le),
      DEFAULT_HISTOGRAM_BUCKETS,
    );
  });

  test('an empty bucket list is rejected', () => {
    assert.throws(() => new Histogram('latency_ms', undefined, []), MetricError);
  });

  test('distinct label sets are distinct time series', () => {
    const histogram = new Histogram('latency_ms', undefined, [10, 100]);
    histogram.observe(5, { route: '/a' });
    histogram.observe(5, { route: '/b' });

    assert.equal(histogram.collect().length, 2);
  });
});

describe('MetricsRegistry: get-or-create', () => {
  test('repeated calls with the same name return the same instrument', () => {
    const registry = new MetricsRegistry();
    const first = registry.counter('requests_total');
    const second = registry.counter('requests_total');

    assert.equal(first, second);
  });

  test('re-registering a name under a different instrument type throws', () => {
    const registry = new MetricsRegistry();
    registry.counter('thing_total');

    assert.throws(() => registry.gauge('thing_total'), MetricError);
    assert.throws(() => registry.histogram('thing_total'), MetricError);
  });

  test('an empty metric name is rejected', () => {
    const registry = new MetricsRegistry();
    assert.throws(() => registry.counter('  '), MetricError);
  });

  test('collect() assembles a snapshot across every registered instrument', () => {
    const registry = new MetricsRegistry();
    registry.counter('requests_total', 'total requests').inc(3);
    registry.gauge('queue_depth').set(2);
    registry.histogram('latency_ms', undefined, [10, 100]).observe(5);

    const snapshot = registry.collect();
    assert.equal(snapshot.length, 3);

    const counterSnap = snapshot.find((m) => m.name === 'requests_total');
    assert.equal(counterSnap?.type, MetricType.Counter);
    assert.equal(counterSnap?.help, 'total requests');
    assert.deepEqual(counterSnap?.samples, [{ labels: {}, value: 3 }]);

    const gaugeSnap = snapshot.find((m) => m.name === 'queue_depth');
    assert.equal(gaugeSnap?.type, MetricType.Gauge);

    const histogramSnap = snapshot.find((m) => m.name === 'latency_ms');
    assert.equal(histogramSnap?.type, MetricType.Histogram);
  });
});

describe('exporters', () => {
  test('export() pushes the current snapshot to every exporter', () => {
    const registry = new MetricsRegistry();
    const first = new InMemoryMetricExporter('first');
    const second = new InMemoryMetricExporter('second');
    registry.addExporter(first);
    registry.addExporter(second);

    registry.counter('requests_total').inc();
    registry.export();

    assert.equal(first.exports.length, 1);
    assert.equal(second.exports.length, 1);
    assert.equal(first.exports[0]?.[0]?.name, 'requests_total');
  });

  test('collect() alone has no exporter side effects', () => {
    const registry = new MetricsRegistry();
    const exporter = new InMemoryMetricExporter();
    registry.addExporter(exporter);

    registry.counter('requests_total').inc();
    registry.collect();

    assert.equal(exporter.exports.length, 0);
  });

  test('a throwing exporter is isolated and counted, others still receive', () => {
    const registry = new MetricsRegistry();
    const broken: MetricExporter = {
      name: 'broken',
      export: () => {
        throw new Error('scrape failed');
      },
    };
    const healthy = new InMemoryMetricExporter('healthy');
    registry.addExporter(broken);
    registry.addExporter(healthy);

    registry.export();

    assert.equal(healthy.exports.length, 1);
    assert.equal(registry.getDiagnostics().exporterFailures, 1);
  });

  test('duplicate exporter names fail loudly; removeExporter stops delivery', () => {
    const registry = new MetricsRegistry();
    const exporter = new InMemoryMetricExporter();
    registry.addExporter(exporter);

    assert.throws(() => registry.addExporter(new InMemoryMetricExporter('memory')), MetricError);

    registry.removeExporter('memory');
    registry.export();

    assert.equal(exporter.exports.length, 0);
    assert.throws(() => registry.removeExporter('memory'), MetricError);
  });

  test('the console exporter writes one parseable JSON line per metric', () => {
    const logged: unknown[] = [];
    const restore = mock.method(console, 'log', (line: unknown) => {
      logged.push(line);
    });

    try {
      new ConsoleMetricExporter().export([
        { type: MetricType.Counter, name: 'requests_total', help: undefined, samples: [{ labels: {}, value: 1 }] },
      ]);
    } finally {
      restore.mock.restore();
    }

    assert.equal(logged.length, 1);
    const parsed = JSON.parse(String(logged[0]));
    assert.deepEqual(parsed, {
      type: 'counter',
      name: 'requests_total',
      samples: [{ labels: {}, value: 1 }],
    });
  });
});

describe('diagnostics', () => {
  test('counters, gauges and histograms are tallied by kind', () => {
    const registry = new MetricsRegistry();
    registry.counter('a_total');
    registry.counter('b_total');
    registry.gauge('c_gauge');
    registry.histogram('d_hist');

    const diagnostics = registry.getDiagnostics();
    assert.equal(diagnostics.countersRegistered, 2);
    assert.equal(diagnostics.gaugesRegistered, 1);
    assert.equal(diagnostics.histogramsRegistered, 1);
  });

  test('exportCount tracks how many times export() was called', () => {
    const registry = new MetricsRegistry();
    registry.export();
    registry.export();

    assert.equal(registry.getDiagnostics().exportCount, 2);
  });

  test('exporters lists registered names', () => {
    const registry = new MetricsRegistry();
    registry.addExporter(new InMemoryMetricExporter('one'));
    registry.addExporter(new InMemoryMetricExporter('two'));

    assert.deepEqual(registry.getDiagnostics().exporters, ['one', 'two']);
  });
});

describe('metric exporter plugin capability', () => {
  function makeExporterPlugin(exporter: MetricExporter): AgentPlugin & MetricExporterProvider {
    return {
      metadata: {
        id: 'test.metric-exporter',
        name: 'Metric Exporter Plugin',
        version: '1.0.0',
        description: 'test',
        author: 'tests',
        capabilities: [PluginCapability.MetricExporterProvider],
      },
      register() {},
      getMetricExporters: () => [exporter],
    };
  }

  test('contributed exporters are harvested, recorded and released', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const exporter = new InMemoryMetricExporter('plugin-exporter');

    await loader.install(makeExporterPlugin(exporter));

    assert.deepEqual(loader.getMetricExporters().map((entry) => entry.name), ['plugin-exporter']);
    assert.deepEqual(
      loader.getInstallation('test.metric-exporter').contributions.metricExporters,
      ['plugin-exporter'],
    );

    await loader.uninstall('test.metric-exporter');
    assert.deepEqual(loader.getMetricExporters(), []);
  });

  test('a contributed exporter wired into the registry receives the snapshot', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const exporter = new InMemoryMetricExporter('plugin-exporter');
    await loader.install(makeExporterPlugin(exporter));

    const registry = new MetricsRegistry();
    for (const contributed of loader.getMetricExporters()) {
      registry.addExporter(contributed);
    }

    registry.counter('reaches_plugin_exporter_total').inc();
    registry.export();

    assert.equal(exporter.exports.length, 1);
    assert.equal(exporter.exports[0]?.[0]?.name, 'reaches_plugin_exporter_total');
  });
});
