import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ObservabilityError, ObservabilityService } from './ObservabilityService.ts';
import { ConsoleLogSink, MemoryLogSink } from './LogSink.ts';
import { LogLevel, meetsThreshold } from './LogLevel.ts';
import { EventBus } from '../events/EventBus.ts';
import { EventType } from '../events/EventType.ts';
import { PluginLoader, PluginRegistry, PluginCapability } from '../plugins/index.ts';
import type { AgentPlugin, LogSinkProvider } from '../plugins/index.ts';
import type { LogSink } from './LogSink.ts';

function makeService(minLevel: LogLevel = LogLevel.Debug) {
  const sink = new MemoryLogSink();
  const service = new ObservabilityService({ minLevel });
  service.addSink(sink);
  return { service, sink };
}

describe('structured logging', () => {
  test('entries carry component, level, message, fields and a timestamp', () => {
    const { service, sink } = makeService();

    service.getLogger('planner').info('plan created', { steps: 3 });

    assert.equal(sink.entries.length, 1);
    const entry = sink.entries[0];
    assert.equal(entry?.component, 'planner');
    assert.equal(entry?.level, LogLevel.Info);
    assert.equal(entry?.message, 'plan created');
    assert.deepEqual(entry?.fields, { steps: 3 });
    assert.ok(entry?.timestamp instanceof Date);
    assert.equal(entry?.correlationId, undefined);
  });

  test('child loggers namespace the component with dots', () => {
    const { service, sink } = makeService();

    service.getLogger('planner').child('llm').child('retry').warn('slow');

    assert.equal(sink.entries[0]?.component, 'planner.llm.retry');
  });

  test('withCorrelation binds the id to every entry; child inherits it', () => {
    const { service, sink } = makeService();
    const logger = service.getLogger('executor').withCorrelation('run-42');

    logger.info('step started');
    logger.child('tool').error('tool failed');

    assert.equal(sink.entries[0]?.correlationId, 'run-42');
    assert.equal(sink.entries[1]?.correlationId, 'run-42');
    assert.equal(sink.entries[1]?.component, 'executor.tool');
  });

  test('loggers are immutable views — rebinding never mutates the parent', () => {
    const { service, sink } = makeService();
    const base = service.getLogger('agent');
    base.withCorrelation('other'); // discarded on purpose

    base.info('no correlation expected');

    assert.equal(sink.entries[0]?.correlationId, undefined);
  });

  test('empty component names are rejected', () => {
    const { service } = makeService();

    assert.throws(() => service.getLogger('  '), ObservabilityError);
  });
});

describe('log levels', () => {
  test('meetsThreshold orders debug < info < warn < error', () => {
    assert.equal(meetsThreshold(LogLevel.Debug, LogLevel.Info), false);
    assert.equal(meetsThreshold(LogLevel.Info, LogLevel.Info), true);
    assert.equal(meetsThreshold(LogLevel.Error, LogLevel.Warn), true);
  });

  test('entries below the threshold are suppressed, not dispatched', () => {
    const { service, sink } = makeService(LogLevel.Warn);
    const logger = service.getLogger('chatty');

    logger.debug('ignored');
    logger.info('ignored');
    logger.warn('kept');
    logger.error('kept');

    assert.deepEqual(sink.entries.map((entry) => entry.level), ['warn', 'error']);
    assert.equal(service.getDiagnostics().suppressedEntries, 2);
    assert.equal(service.getDiagnostics().totalEntries, 2);
  });
});

describe('sinks', () => {
  test('every sink receives every accepted entry', () => {
    const service = new ObservabilityService({ minLevel: LogLevel.Debug });
    const first = new MemoryLogSink('first');
    const second = new MemoryLogSink('second');
    service.addSink(first);
    service.addSink(second);

    service.getLogger('app').info('hello');

    assert.equal(first.entries.length, 1);
    assert.equal(second.entries.length, 1);
  });

  test('a throwing sink is isolated and counted, others still receive', () => {
    const service = new ObservabilityService({ minLevel: LogLevel.Debug });
    const broken: LogSink = {
      name: 'broken',
      write: () => {
        throw new Error('disk full');
      },
    };
    const healthy = new MemoryLogSink('healthy');
    service.addSink(broken);
    service.addSink(healthy);

    service.getLogger('app').info('survives');

    assert.equal(healthy.entries.length, 1);
    assert.equal(service.getDiagnostics().sinkFailures, 1);
  });

  test('duplicate sink names fail loudly; removeSink stops delivery', () => {
    const { service, sink } = makeService();

    assert.throws(() => service.addSink(new MemoryLogSink('memory')), ObservabilityError);

    service.removeSink('memory');
    service.getLogger('app').info('nobody listening');

    assert.equal(sink.entries.length, 0);
    assert.throws(() => service.removeSink('memory'), ObservabilityError);
  });

  test('the console sink writes one parseable JSON line per entry', () => {
    const logged: unknown[] = [];
    const restore = mock.method(console, 'log', (line: unknown) => {
      logged.push(line);
    });

    try {
      new ConsoleLogSink().write({
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
        level: LogLevel.Info,
        component: 'app',
        message: 'hello',
        correlationId: 'run-1',
        fields: { answer: 42 },
      });
    } finally {
      restore.mock.restore();
    }

    assert.equal(logged.length, 1);
    const parsed = JSON.parse(String(logged[0]));
    assert.deepEqual(parsed, {
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'info',
      component: 'app',
      message: 'hello',
      correlationId: 'run-1',
      fields: { answer: 42 },
    });
  });

  test('the console sink routes warn and error to stderr', () => {
    const errors: unknown[] = [];
    const restore = mock.method(console, 'error', (line: unknown) => {
      errors.push(line);
    });

    try {
      new ConsoleLogSink().write({
        timestamp: new Date(),
        level: LogLevel.Error,
        component: 'app',
        message: 'boom',
      });
    } finally {
      restore.mock.restore();
    }

    assert.equal(errors.length, 1);
  });
});

describe('event bus bridge', () => {
  test('published events become correlated debug entries', () => {
    const { service, sink } = makeService(LogLevel.Debug);
    const bus = new EventBus();
    service.observeEventBus(bus);

    const envelope = bus.publish({
      type: EventType.TaskCreated,
      source: 'delegation',
      correlationId: 'task-7',
      payload: { title: 'do the thing' },
    });

    assert.equal(sink.entries.length, 1);
    const entry = sink.entries[0];
    assert.equal(entry?.component, 'events.delegation');
    assert.equal(entry?.level, LogLevel.Debug);
    assert.equal(entry?.message, EventType.TaskCreated);
    assert.equal(entry?.correlationId, 'task-7');
    assert.deepEqual(entry?.fields, {
      eventId: envelope.eventId,
      payload: { title: 'do the thing' },
    });
  });

  test('at the default info threshold, event traffic is counted but quiet', () => {
    const sink = new MemoryLogSink();
    const service = new ObservabilityService(); // default minLevel: info
    service.addSink(sink);
    const bus = new EventBus();
    service.observeEventBus(bus);

    bus.publish({ type: EventType.TaskCreated, source: 'delegation' });

    assert.equal(sink.entries.length, 0, 'debug entries suppressed');
    assert.equal(service.getDiagnostics().suppressedEntries, 1);
  });
});

describe('log sink plugin capability', () => {
  function makeSinkPlugin(sink: LogSink): AgentPlugin & LogSinkProvider {
    return {
      metadata: {
        id: 'test.sink',
        name: 'Sink Plugin',
        version: '1.0.0',
        description: 'test',
        author: 'tests',
        capabilities: [PluginCapability.LogSinkProvider],
      },
      register() {},
      getLogSinks: () => [sink],
    };
  }

  test('contributed sinks are harvested, recorded and released', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const sink = new MemoryLogSink('plugin-sink');

    await loader.install(makeSinkPlugin(sink));

    assert.deepEqual(loader.getLogSinks().map((entry) => entry.name), ['plugin-sink']);
    assert.deepEqual(
      loader.getInstallation('test.sink').contributions.logSinks,
      ['plugin-sink'],
    );

    await loader.uninstall('test.sink');
    assert.deepEqual(loader.getLogSinks(), []);
  });

  test('a contributed sink wired into the service receives entries', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const sink = new MemoryLogSink('plugin-sink');
    await loader.install(makeSinkPlugin(sink));

    const service = new ObservabilityService({ minLevel: LogLevel.Debug });
    for (const contributed of loader.getLogSinks()) {
      service.addSink(contributed);
    }

    service.getLogger('app').info('reaches the plugin sink');

    assert.equal(sink.entries.length, 1);
    assert.equal(sink.entries[0]?.message, 'reaches the plugin sink');
  });
});

describe('component-aware plugin logging', () => {
  test('plugin context.log routes through the loader logger', async () => {
    const { service, sink } = makeService(LogLevel.Debug);
    const loader = new PluginLoader(
      new PluginRegistry(),
      undefined,
      service.getLogger('plugins'),
    );

    await loader.install({
      metadata: {
        id: 'test.talker',
        name: 'Talker',
        version: '1.0.0',
        description: 'test',
        author: 'tests',
        capabilities: [],
      },
      register(context) {
        context.log('hello from register');
      },
    });

    const entry = sink.entries.find((e) => e.message === 'hello from register');
    assert.equal(entry?.component, 'plugins.test.talker');
    assert.equal(entry?.level, LogLevel.Info);
  });
});

describe('diagnostics', () => {
  test('counters aggregate by level and list sinks', () => {
    const { service } = makeService(LogLevel.Debug);
    const logger = service.getLogger('app');

    logger.debug('d');
    logger.info('i');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    assert.deepEqual(service.getDiagnostics(), {
      totalEntries: 5,
      suppressedEntries: 0,
      entriesByLevel: { debug: 1, info: 2, warn: 1, error: 1 },
      sinks: ['memory'],
      sinkFailures: 0,
    });
  });
});
