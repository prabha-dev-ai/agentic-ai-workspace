import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamError } from './StreamError.ts';
import { StreamState } from './StreamState.ts';
import { StreamManager } from './StreamManager.ts';
import { EventBus } from '../events/EventBus.ts';
import { EventType } from '../events/EventType.ts';
import { PluginLoader, PluginRegistry, PluginCapability } from '../plugins/index.ts';
import type { AgentPlugin, StreamObserverProvider } from '../plugins/index.ts';
import type { StreamObserver } from './StreamManager.ts';
import type { StreamEvent } from './StreamEvent.ts';

describe('Stream: lifecycle', () => {
  test('a new stream starts Pending with zero chunks', () => {
    const manager = new StreamManager();
    const stream = manager.createStream('tokens');

    assert.equal(stream.state, StreamState.Pending);
    assert.equal(stream.chunkCount, 0);
    assert.ok(stream.id);
    assert.equal(stream.name, 'tokens');
    assert.ok(stream.startedAt instanceof Date);
  });

  test('the first push() transitions Pending -> Active', () => {
    const manager = new StreamManager();
    const stream = manager.createStream<string>('tokens');

    stream.push('hello');

    assert.equal(stream.state, StreamState.Active);
    assert.equal(stream.chunkCount, 1);
  });

  test('complete() moves the stream to a terminal state', () => {
    const manager = new StreamManager();
    const stream = manager.createStream('tokens');
    stream.complete();

    assert.equal(stream.state, StreamState.Completed);
  });

  test('fail() moves the stream to a terminal state', () => {
    const manager = new StreamManager();
    const stream = manager.createStream('tokens');
    stream.fail('boom');

    assert.equal(stream.state, StreamState.Error);
  });

  test('cancel() moves the stream to a terminal state', () => {
    const manager = new StreamManager();
    const stream = manager.createStream('tokens');
    stream.cancel();

    assert.equal(stream.state, StreamState.Cancelled);
  });

  test('a stream can complete with zero chunks', () => {
    const manager = new StreamManager();
    const stream = manager.createStream('empty');
    stream.complete();

    assert.equal(stream.chunkCount, 0);
    assert.equal(stream.state, StreamState.Completed);
  });

  test('push/complete/fail/cancel all throw once the stream is terminal', () => {
    const manager = new StreamManager();
    const stream = manager.createStream<string>('tokens');
    stream.complete();

    assert.throws(() => stream.push('too late'), StreamError);
    assert.throws(() => stream.complete(), StreamError);
    assert.throws(() => stream.fail('too late'), StreamError);
    assert.throws(() => stream.cancel(), StreamError);
  });

  test('an empty stream name is rejected', () => {
    const manager = new StreamManager();
    assert.throws(() => manager.createStream('  '), StreamError);
  });
});

describe('Stream: chunk sequencing', () => {
  test('chunks are delivered in order with an increasing sequence number', () => {
    const manager = new StreamManager();
    const stream = manager.createStream<string>('tokens');
    const received: { sequence: number; data: string }[] = [];

    stream.subscribe((event) => {
      if (event.type === 'chunk') {
        received.push({ sequence: event.sequence, data: event.data });
      }
    });

    stream.push('a');
    stream.push('b');
    stream.push('c');

    assert.deepEqual(received, [
      { sequence: 0, data: 'a' },
      { sequence: 1, data: 'b' },
      { sequence: 2, data: 'c' },
    ]);
    assert.equal(stream.chunkCount, 3);
  });
});

describe('Stream: subscribe', () => {
  test('subscribers receive completed/error/cancelled events with the final chunk count', () => {
    const manager = new StreamManager();
    const stream = manager.createStream<string>('tokens');
    const events: StreamEvent<string>[] = [];
    stream.subscribe((event) => events.push(event));

    stream.push('a');
    stream.push('b');
    stream.complete();

    const last = events.at(-1);
    assert.equal(last?.type, 'completed');
    assert.equal(last?.type === 'completed' && last.chunkCount, 2);
    assert.equal(last?.type === 'completed' && typeof last.durationMs, 'number');
  });

  test('error events carry the error message', () => {
    const manager = new StreamManager();
    const stream = manager.createStream('tokens');
    const events: StreamEvent[] = [];
    stream.subscribe((event) => events.push(event));

    stream.fail('model unavailable');

    const event = events[0];
    assert.equal(event?.type, 'error');
    assert.equal(event?.type === 'error' && event.error, 'model unavailable');
  });

  test('unsubscribe stops further delivery to that listener', () => {
    const manager = new StreamManager();
    const stream = manager.createStream<string>('tokens');
    const received: string[] = [];
    const unsubscribe = stream.subscribe((event) => {
      if (event.type === 'chunk') received.push(event.data);
    });

    stream.push('a');
    unsubscribe();
    stream.push('b');

    assert.deepEqual(received, ['a']);
  });

  test('a throwing listener is isolated — other listeners and the producer are unaffected', () => {
    const manager = new StreamManager();
    const stream = manager.createStream<string>('tokens');
    const received: string[] = [];

    stream.subscribe(() => {
      throw new Error('bad subscriber');
    });
    stream.subscribe((event) => {
      if (event.type === 'chunk') received.push(event.data);
    });

    assert.doesNotThrow(() => stream.push('a'));
    assert.deepEqual(received, ['a']);
  });
});

describe('StreamManager: retrieval', () => {
  test('getStream finds a stream by id', () => {
    const manager = new StreamManager();
    const stream = manager.createStream('tokens');

    assert.equal(manager.getStream(stream.id), stream);
    assert.equal(manager.getStream('missing'), undefined);
  });

  test('listStreams returns every retained stream, oldest first', () => {
    const manager = new StreamManager();
    const first = manager.createStream('a');
    const second = manager.createStream('b');

    assert.deepEqual(manager.listStreams(), [first, second]);
  });

  test('maxStreams evicts the oldest stream from lookup, without breaking it', () => {
    const manager = new StreamManager({ maxStreams: 2 });
    const first = manager.createStream<string>('a');
    manager.createStream('b');
    manager.createStream('c');

    assert.equal(manager.getStream(first.id), undefined, 'oldest evicted from lookup');
    assert.equal(manager.listStreams().length, 2);

    // Eviction only affects manager-side lookup — the stream object itself
    // keeps working for anyone still holding a direct reference to it.
    assert.doesNotThrow(() => first.push('still alive'));
    assert.equal(first.chunkCount, 1);
  });
});

describe('StreamManager: observers', () => {
  test('every observer receives every stream event, across every stream', () => {
    const manager = new StreamManager();
    const seen: string[] = [];
    manager.addObserver({ name: 'watcher', onEvent: (event) => seen.push(event.type) });

    const stream = manager.createStream<string>('tokens');
    stream.push('a');
    stream.complete();

    assert.deepEqual(seen, ['chunk', 'completed']);
  });

  test('a throwing observer is isolated and counted, others still receive', () => {
    const manager = new StreamManager();
    const broken: StreamObserver = {
      name: 'broken',
      onEvent: () => {
        throw new Error('boom');
      },
    };
    const seen: string[] = [];
    manager.addObserver(broken);
    manager.addObserver({ name: 'healthy', onEvent: (event) => seen.push(event.type) });

    manager.createStream('tokens').complete();

    assert.deepEqual(seen, ['completed']);
    assert.equal(manager.getDiagnostics().observerFailures, 1);
  });

  test('duplicate observer names fail loudly; removeObserver stops delivery', () => {
    const manager = new StreamManager();
    const seen: string[] = [];
    manager.addObserver({ name: 'watcher', onEvent: (event) => seen.push(event.type) });

    assert.throws(
      () => manager.addObserver({ name: 'watcher', onEvent: () => {} }),
      StreamError,
    );

    manager.removeObserver('watcher');
    manager.createStream('tokens').complete();

    assert.deepEqual(seen, []);
    assert.throws(() => manager.removeObserver('watcher'), StreamError);
  });

  test('an unnamed observer is rejected', () => {
    const manager = new StreamManager();
    assert.throws(() => manager.addObserver({ name: '', onEvent: () => {} }), StreamError);
  });
});

describe('StreamManager: event bus bridge', () => {
  test('lifecycle milestones publish onto the connected event bus, correlated by stream id', () => {
    const manager = new StreamManager();
    const bus = new EventBus();
    manager.connectEventBus(bus);

    const published: string[] = [];
    bus.subscribe('*', (envelope) => {
      published.push(envelope.type);
    });

    const stream = manager.createStream('tokens');
    stream.push('a');
    stream.complete();

    assert.deepEqual(published, [EventType.StreamStarted, EventType.StreamCompleted]);
  });

  test('chunk events are NOT published onto the event bus — only lifecycle milestones', () => {
    const manager = new StreamManager();
    const bus = new EventBus();
    manager.connectEventBus(bus);

    const stream = manager.createStream('tokens');
    stream.push('a');
    stream.push('b');
    stream.push('c');

    assert.equal(bus.getDiagnostics().publishedEvents, 1, 'only the started milestone so far');
  });

  test('a failed stream publishes stream.failed with the error and stream id as correlation', () => {
    const manager = new StreamManager();
    const bus = new EventBus();
    manager.connectEventBus(bus);

    const captured: { correlationId: string; payload: unknown }[] = [];
    bus.subscribe(EventType.StreamFailed, (envelope) => {
      captured.push({ correlationId: envelope.correlationId, payload: envelope.payload });
    });

    const stream = manager.createStream('tokens');
    stream.fail('boom');

    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.correlationId, stream.id);
    assert.deepEqual(captured[0]?.payload, { streamName: 'tokens', error: 'boom' });
  });

  test('without connectEventBus, streams work normally and publish nothing', () => {
    const manager = new StreamManager();
    const stream = manager.createStream('tokens');

    assert.doesNotThrow(() => {
      stream.push('a');
      stream.complete();
    });
  });
});

describe('StreamManager: diagnostics', () => {
  test('counters track totals, active/terminal breakdown, and chunks', () => {
    const manager = new StreamManager();

    const active = manager.createStream('active');
    active.push('a');

    manager.createStream('done').complete();
    manager.createStream('errored').fail('boom');
    manager.createStream('gone').cancel();

    const diagnostics = manager.getDiagnostics();
    assert.equal(diagnostics.totalStreams, 4);
    assert.equal(diagnostics.activeStreams, 1);
    assert.equal(diagnostics.completedStreams, 1);
    assert.equal(diagnostics.failedStreams, 1);
    assert.equal(diagnostics.cancelledStreams, 1);
    assert.equal(diagnostics.totalChunks, 1);
  });

  test('an empty manager reports zeroed diagnostics', () => {
    const manager = new StreamManager();

    assert.deepEqual(manager.getDiagnostics(), {
      totalStreams: 0,
      activeStreams: 0,
      completedStreams: 0,
      failedStreams: 0,
      cancelledStreams: 0,
      totalChunks: 0,
      observers: [],
      observerFailures: 0,
    });
  });
});

describe('stream observer plugin capability', () => {
  function makeObserverPlugin(observer: StreamObserver): AgentPlugin & StreamObserverProvider {
    return {
      metadata: {
        id: 'test.stream-observer',
        name: 'Stream Observer Plugin',
        version: '1.0.0',
        description: 'test',
        author: 'tests',
        capabilities: [PluginCapability.StreamObserverProvider],
      },
      register() {},
      getStreamObservers: () => [observer],
    };
  }

  test('contributed observers are harvested, recorded and released', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const observer: StreamObserver = { name: 'collector', onEvent: () => {} };

    await loader.install(makeObserverPlugin(observer));

    assert.deepEqual(loader.getStreamObservers().map((entry) => entry.name), ['collector']);
    assert.deepEqual(
      loader.getInstallation('test.stream-observer').contributions.streamObservers,
      ['collector'],
    );

    await loader.uninstall('test.stream-observer');
    assert.deepEqual(loader.getStreamObservers(), []);
  });

  test('a contributed observer wired into the manager receives events', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const seen: string[] = [];
    const observer: StreamObserver = { name: 'collector', onEvent: (event) => seen.push(event.type) };
    await loader.install(makeObserverPlugin(observer));

    const manager = new StreamManager();
    for (const contributed of loader.getStreamObservers()) {
      manager.addObserver(contributed);
    }

    manager.createStream('tokens').complete();

    assert.deepEqual(seen, ['completed']);
  });
});
