import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { TraceError, TraceManager } from './TraceManager.ts';
import { ConsoleSpanExporter, InMemorySpanExporter } from './SpanExporter.ts';
import { SpanStatus } from './SpanStatus.ts';
import { EventBus } from '../events/EventBus.ts';
import { EventType } from '../events/EventType.ts';
import { PluginLoader, PluginRegistry, PluginCapability } from '../plugins/index.ts';
import type { AgentPlugin, SpanExporterProvider } from '../plugins/index.ts';
import type { SpanExporter } from './SpanExporter.ts';

function makeManager(maxTraces?: number) {
  const exporter = new InMemorySpanExporter();
  const manager = new TraceManager(maxTraces !== undefined ? { maxTraces } : {});
  manager.addExporter(exporter);
  return { manager, exporter };
}

describe('span model & automatic timing', () => {
  test('a span carries trace id, span id, name, component and a start time', () => {
    const { manager } = makeManager();
    const tracer = manager.getTracer('planner');

    const span = tracer.startSpan('plan.create');

    assert.equal(span.name, 'plan.create');
    assert.equal(span.component, 'planner');
    assert.equal(span.parentSpanId, undefined);
    assert.ok(span.traceId);
    assert.ok(span.spanId);
    assert.ok(span.startTime instanceof Date);
  });

  test('end() records endTime and durationMs automatically', async () => {
    const { manager, exporter } = makeManager();
    const span = manager.getTracer('app').startSpan('slow.step');

    await sleep(10);
    span.end();

    assert.equal(exporter.spans.length, 1);
    const recorded = exporter.spans[0]!;
    assert.ok(recorded.endTime instanceof Date);
    assert.ok(recorded.endTime.getTime() >= recorded.startTime.getTime());
    assert.equal(recorded.durationMs, recorded.endTime.getTime() - recorded.startTime.getTime());
    assert.ok(recorded.durationMs >= 1, 'a real delay must be reflected in durationMs');
  });

  test('end() defaults to SpanStatus.Ok with no error', () => {
    const { manager, exporter } = makeManager();
    manager.getTracer('app').startSpan('step').end();

    assert.equal(exporter.spans[0]?.status, SpanStatus.Ok);
    assert.equal(exporter.spans[0]?.error, undefined);
  });

  test('ending an already-ended span throws', () => {
    const { manager } = makeManager();
    const span = manager.getTracer('app').startSpan('step');

    span.end();
    assert.throws(() => span.end(), TraceError);
  });

  test('setAttribute/setAttributes are captured on the finished span', () => {
    const { manager, exporter } = makeManager();
    const span = manager.getTracer('app').startSpan('step');

    span.setAttribute('tool', 'search');
    span.setAttributes({ retries: 2, cached: false });
    span.end();

    assert.deepEqual(exporter.spans[0]?.attributes, {
      tool: 'search',
      retries: 2,
      cached: false,
    });
  });

  test('empty span or component names are rejected', () => {
    const { manager } = makeManager();

    assert.throws(() => manager.getTracer('  '), TraceError);
    assert.throws(() => manager.getTracer('app').startSpan(''), TraceError);
  });
});

describe('parent/child spans & TraceContext propagation', () => {
  test('a root span gets a fresh trace id and no parent', () => {
    const { manager } = makeManager();
    const span = manager.getTracer('app').startSpan('root');

    assert.equal(span.parentSpanId, undefined);
  });

  test('startChild shares the trace and is parented to the calling span', () => {
    const { manager } = makeManager();
    const root = manager.getTracer('planner').startSpan('plan.create');
    const child = root.startChild('plan.llm-call');

    assert.equal(child.traceId, root.traceId);
    assert.equal(child.parentSpanId, root.spanId);
    assert.notEqual(child.spanId, root.spanId);
  });

  test('a TraceContext read off one span parents a span started from an unrelated tracer', () => {
    const { manager } = makeManager();
    const root = manager.getTracer('supervisor').startSpan('delegate');
    const context = root.context();

    const downstream = manager.getTracer('executor').startSpan('tool.execute', {
      parent: context,
    });

    assert.equal(downstream.traceId, root.traceId);
    assert.equal(downstream.parentSpanId, root.spanId);
    assert.equal(downstream.component, 'executor');
  });

  test('getTrace assembles every span for a trace id, in finish order, with rootSpanId', () => {
    const { manager } = makeManager();
    const tracer = manager.getTracer('app');

    const root = tracer.startSpan('root');
    const child = root.startChild('child');
    child.end();
    root.end();

    const trace = manager.getTrace(root.traceId);
    assert.ok(trace);
    assert.equal(trace?.spans.length, 2);
    assert.deepEqual(trace?.spans.map((s) => s.name), ['child', 'root']);
    assert.equal(trace?.rootSpanId, root.spanId);
    assert.ok((trace?.durationMs ?? -1) >= 0);
  });
});

describe('withSpan / withSpanAsync', () => {
  test('withSpan ends the span Ok and returns the function result', () => {
    const { manager, exporter } = makeManager();
    const tracer = manager.getTracer('app');

    const result = tracer.withSpan('step', (span) => {
      span.setAttribute('ok', true);
      return 42;
    });

    assert.equal(result, 42);
    assert.equal(exporter.spans[0]?.status, SpanStatus.Ok);
    assert.deepEqual(exporter.spans[0]?.attributes, { ok: true });
  });

  test('withSpan records Error status and message, then rethrows', () => {
    const { manager, exporter } = makeManager();
    const tracer = manager.getTracer('app');

    assert.throws(() => {
      tracer.withSpan('step', () => {
        throw new Error('boom');
      });
    }, /boom/);

    assert.equal(exporter.spans[0]?.status, SpanStatus.Error);
    assert.equal(exporter.spans[0]?.error, 'boom');
  });

  test('withSpanAsync ends the span Ok and resolves with the function result', async () => {
    const { manager, exporter } = makeManager();
    const tracer = manager.getTracer('app');

    const result = await tracer.withSpanAsync('step', async (span) => {
      await sleep(1);
      span.setAttribute('async', true);
      return 'done';
    });

    assert.equal(result, 'done');
    assert.equal(exporter.spans[0]?.status, SpanStatus.Ok);
  });

  test('withSpanAsync records Error status when the promise rejects, then rethrows', async () => {
    const { manager, exporter } = makeManager();
    const tracer = manager.getTracer('app');

    await assert.rejects(
      tracer.withSpanAsync('step', async () => {
        throw new Error('async boom');
      }),
      /async boom/,
    );

    assert.equal(exporter.spans[0]?.status, SpanStatus.Error);
    assert.equal(exporter.spans[0]?.error, 'async boom');
  });
});

describe('exporters', () => {
  test('every exporter receives every finished span', () => {
    const manager = new TraceManager();
    const first = new InMemorySpanExporter('first');
    const second = new InMemorySpanExporter('second');
    manager.addExporter(first);
    manager.addExporter(second);

    manager.getTracer('app').startSpan('step').end();

    assert.equal(first.spans.length, 1);
    assert.equal(second.spans.length, 1);
  });

  test('a throwing exporter is isolated and counted, others still receive', () => {
    const manager = new TraceManager();
    const broken: SpanExporter = {
      name: 'broken',
      export: () => {
        throw new Error('disk full');
      },
    };
    const healthy = new InMemorySpanExporter('healthy');
    manager.addExporter(broken);
    manager.addExporter(healthy);

    manager.getTracer('app').startSpan('step').end();

    assert.equal(healthy.spans.length, 1);
    assert.equal(manager.getDiagnostics().exporterFailures, 1);
  });

  test('duplicate exporter names fail loudly; removeExporter stops delivery', () => {
    const { manager, exporter } = makeManager();

    assert.throws(() => manager.addExporter(new InMemorySpanExporter('memory')), TraceError);

    manager.removeExporter('memory');
    manager.getTracer('app').startSpan('step').end();

    assert.equal(exporter.spans.length, 0);
    assert.throws(() => manager.removeExporter('memory'), TraceError);
  });
});

describe('the console exporter', () => {
  test('writes one parseable JSON line to stdout for an ok span', () => {
    const logged: unknown[] = [];
    const restore = mock.method(console, 'log', (line: unknown) => {
      logged.push(line);
    });

    try {
      new ConsoleSpanExporter().export({
        traceId: 'trace-1',
        spanId: 'span-1',
        parentSpanId: undefined,
        name: 'step',
        component: 'app',
        startTime: new Date('2026-01-01T00:00:00.000Z'),
        endTime: new Date('2026-01-01T00:00:00.010Z'),
        durationMs: 10,
        status: SpanStatus.Ok,
        attributes: { answer: 42 },
        error: undefined,
      });
    } finally {
      restore.mock.restore();
    }

    assert.equal(logged.length, 1);
    const parsed = JSON.parse(String(logged[0]));
    assert.deepEqual(parsed, {
      traceId: 'trace-1',
      spanId: 'span-1',
      name: 'step',
      component: 'app',
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:00:00.010Z',
      durationMs: 10,
      status: 'ok',
      attributes: { answer: 42 },
    });
  });

  test('routes error-status spans to stderr', () => {
    const errors: unknown[] = [];
    const restore = mock.method(console, 'error', (line: unknown) => {
      errors.push(line);
    });

    try {
      new ConsoleSpanExporter().export({
        traceId: 'trace-1',
        spanId: 'span-1',
        parentSpanId: undefined,
        name: 'step',
        component: 'app',
        startTime: new Date(),
        endTime: new Date(),
        durationMs: 0,
        status: SpanStatus.Error,
        attributes: {},
        error: 'boom',
      });
    } finally {
      restore.mock.restore();
    }

    assert.equal(errors.length, 1);
  });
});

describe('trace retention', () => {
  test('maxTraces evicts the oldest trace first', () => {
    const manager = new TraceManager({ maxTraces: 2 });
    const tracer = manager.getTracer('app');

    const first = tracer.startSpan('one');
    first.end();
    const second = tracer.startSpan('two');
    second.end();
    const third = tracer.startSpan('three');
    third.end();

    assert.equal(manager.getTrace(first.traceId), undefined, 'oldest trace evicted');
    assert.ok(manager.getTrace(second.traceId));
    assert.ok(manager.getTrace(third.traceId));
    assert.equal(manager.listTraces().length, 2);
  });
});

describe('event bus bridge', () => {
  test('published events become zero-duration spans keyed by correlation id', () => {
    const { manager, exporter } = makeManager();
    const bus = new EventBus();
    manager.observeEventBus(bus);

    const envelope = bus.publish({
      type: EventType.TaskCreated,
      source: 'delegation',
      correlationId: 'task-7',
      payload: { title: 'do the thing' },
    });

    assert.equal(exporter.spans.length, 1);
    const span = exporter.spans[0]!;
    assert.equal(span.traceId, 'task-7');
    assert.equal(span.component, 'events');
    assert.equal(span.name, EventType.TaskCreated);
    assert.equal(span.durationMs, 0);
    assert.deepEqual(span.attributes, { eventId: envelope.eventId, source: 'delegation' });
  });

  test('events sharing a correlation id land in the same trace', () => {
    const { manager, exporter } = makeManager();
    const bus = new EventBus();
    manager.observeEventBus(bus);

    bus.publish({ type: EventType.TaskCreated, source: 'delegation', correlationId: 'flow-1' });
    bus.publish({ type: EventType.TaskCompleted, source: 'delegation', correlationId: 'flow-1' });

    assert.equal(exporter.spans.length, 2);
    assert.equal(exporter.spans[0]?.traceId, exporter.spans[1]?.traceId);

    const trace = manager.getTrace('flow-1');
    assert.equal(trace?.spans.length, 2);
  });
});

describe('diagnostics', () => {
  test('counters track spans, open spans, traces and exporters', () => {
    const { manager } = makeManager();
    const tracer = manager.getTracer('app');

    const open = tracer.startSpan('still-running');
    tracer.startSpan('done').end();

    const diagnostics = manager.getDiagnostics();
    assert.equal(diagnostics.totalSpans, 2);
    assert.equal(diagnostics.openSpans, 1);
    assert.equal(diagnostics.totalTraces, 1, 'a trace is only recorded once a span in it ends');
    assert.deepEqual(diagnostics.exporters, ['memory']);
    assert.equal(diagnostics.exporterFailures, 0);

    open.end();
    const after = manager.getDiagnostics();
    assert.equal(after.openSpans, 0);
    assert.equal(after.totalTraces, 2);
  });
});

describe('span exporter plugin capability', () => {
  function makeExporterPlugin(exporter: SpanExporter): AgentPlugin & SpanExporterProvider {
    return {
      metadata: {
        id: 'test.exporter',
        name: 'Exporter Plugin',
        version: '1.0.0',
        description: 'test',
        author: 'tests',
        capabilities: [PluginCapability.SpanExporterProvider],
      },
      register() {},
      getSpanExporters: () => [exporter],
    };
  }

  test('contributed exporters are harvested, recorded and released', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const exporter = new InMemorySpanExporter('plugin-exporter');

    await loader.install(makeExporterPlugin(exporter));

    assert.deepEqual(loader.getSpanExporters().map((entry) => entry.name), ['plugin-exporter']);
    assert.deepEqual(
      loader.getInstallation('test.exporter').contributions.spanExporters,
      ['plugin-exporter'],
    );

    await loader.uninstall('test.exporter');
    assert.deepEqual(loader.getSpanExporters(), []);
  });

  test('a contributed exporter wired into the manager receives spans', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const exporter = new InMemorySpanExporter('plugin-exporter');
    await loader.install(makeExporterPlugin(exporter));

    const manager = new TraceManager();
    for (const contributed of loader.getSpanExporters()) {
      manager.addExporter(contributed);
    }

    manager.getTracer('app').startSpan('reaches-the-plugin-exporter').end();

    assert.equal(exporter.spans.length, 1);
    assert.equal(exporter.spans[0]?.name, 'reaches-the-plugin-exporter');
  });
});
