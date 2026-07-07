import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { CacheError } from './Cache.ts';
import { InMemoryCache } from './InMemoryCache.ts';
import { CacheRegistry } from './CacheRegistry.ts';
import { PluginLoader, PluginRegistry, PluginCapability } from '../plugins/index.ts';
import type { AgentPlugin, CacheProvider } from '../plugins/index.ts';
import type { Cache } from './Cache.ts';

describe('InMemoryCache: basic operations', () => {
  test('set then get returns the stored value', () => {
    const cache = new InMemoryCache<string>('test');
    cache.set('a', 'apple');

    assert.equal(cache.get('a'), 'apple');
  });

  test('get on a missing key returns undefined and counts a miss', () => {
    const cache = new InMemoryCache('test');

    assert.equal(cache.get('missing'), undefined);
    assert.equal(cache.getStats().misses, 1);
    assert.equal(cache.getStats().hits, 0);
  });

  test('has reflects presence without consuming a hit/miss', () => {
    const cache = new InMemoryCache<string>('test');
    cache.set('a', 'apple');

    assert.equal(cache.has('a'), true);
    assert.equal(cache.has('missing'), false);
    assert.equal(cache.getStats().hits, 0);
    assert.equal(cache.getStats().misses, 0);
  });

  test('delete removes an entry and reports whether it existed', () => {
    const cache = new InMemoryCache<string>('test');
    cache.set('a', 'apple');

    assert.equal(cache.delete('a'), true);
    assert.equal(cache.delete('a'), false);
    assert.equal(cache.has('a'), false);
    assert.equal(cache.getStats().deletes, 1);
  });

  test('clear empties the cache without affecting counters', () => {
    const cache = new InMemoryCache<string>('test');
    cache.set('a', 'apple');
    cache.set('b', 'banana');

    cache.clear();

    assert.equal(cache.size, 0);
    assert.equal(cache.has('a'), false);
  });

  test('size reflects the current entry count', () => {
    const cache = new InMemoryCache<string>('test');
    cache.set('a', '1');
    cache.set('b', '2');

    assert.equal(cache.size, 2);
  });

  test('an empty cache name is rejected', () => {
    assert.throws(() => new InMemoryCache('  '), CacheError);
  });
});

describe('InMemoryCache: TTL', () => {
  test('an entry with a TTL expires and is treated as a miss afterward', async () => {
    const cache = new InMemoryCache<string>('test');
    cache.set('a', 'apple', { ttlMs: 5 });

    assert.equal(cache.get('a'), 'apple');

    await sleep(15);

    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.has('a'), false);
    assert.equal(cache.getStats().expirations, 1);
  });

  test('a cache-level default TTL applies when set() does not specify one', async () => {
    const cache = new InMemoryCache<string>('test', { defaultTtlMs: 5 });
    cache.set('a', 'apple');

    await sleep(15);

    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.getStats().expirations, 1);
  });

  test('set() TTL overrides the cache-level default', () => {
    const cache = new InMemoryCache<string>('test', { defaultTtlMs: 5 });
    cache.set('a', 'apple', { ttlMs: 1_000_000 });

    assert.equal(cache.get('a'), 'apple');
  });

  test('no TTL means the entry never expires', async () => {
    const cache = new InMemoryCache<string>('test');
    cache.set('a', 'apple');

    await sleep(10);

    assert.equal(cache.get('a'), 'apple');
  });
});

describe('InMemoryCache: eviction', () => {
  test('exceeding maxEntries evicts the least-recently-used entry', () => {
    const cache = new InMemoryCache<string>('test', { maxEntries: 2 });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');

    assert.equal(cache.has('a'), false, 'oldest entry evicted');
    assert.equal(cache.has('b'), true);
    assert.equal(cache.has('c'), true);
    assert.equal(cache.getStats().evictions, 1);
    assert.equal(cache.size, 2);
  });

  test('reading an entry marks it as recently used, protecting it from eviction', () => {
    const cache = new InMemoryCache<string>('test', { maxEntries: 2 });
    cache.set('a', '1');
    cache.set('b', '2');

    cache.get('a'); // touch 'a' — 'b' is now the least-recently-used

    cache.set('c', '3');

    assert.equal(cache.has('a'), true, 'recently touched entry survives');
    assert.equal(cache.has('b'), false, 'untouched entry evicted');
    assert.equal(cache.has('c'), true);
  });

  test('a non-positive maxEntries is rejected', () => {
    assert.throws(() => new InMemoryCache('test', { maxEntries: 0 }), CacheError);
    assert.throws(() => new InMemoryCache('test', { maxEntries: -1 }), CacheError);
  });
});

describe('InMemoryCache: statistics', () => {
  test('hits, misses, sets, deletes, evictions and expirations are tallied independently', async () => {
    const cache = new InMemoryCache<string>('test', { maxEntries: 1 });

    cache.set('a', '1'); // set
    cache.get('a'); // hit
    cache.get('missing'); // miss
    cache.set('b', '2', { ttlMs: 5 }); // set, evicts 'a'
    cache.delete('b'); // delete
    cache.set('c', '3', { ttlMs: 5 }); // set
    await sleep(15);
    cache.get('c'); // miss (expired)

    const stats = cache.getStats();
    assert.equal(stats.sets, 3);
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 2);
    assert.equal(stats.deletes, 1);
    assert.equal(stats.evictions, 1);
    assert.equal(stats.expirations, 1);
    assert.equal(stats.size, 0);
  });
});

describe('CacheRegistry: get-or-create', () => {
  test('repeated calls with the same name return the same cache', () => {
    const registry = new CacheRegistry();
    const first = registry.getOrCreate('plans');
    const second = registry.getOrCreate('plans');

    assert.equal(first, second);
  });

  test('creation options only apply the first time a name is used', () => {
    const registry = new CacheRegistry();
    const first = registry.getOrCreate('plans', { maxEntries: 1 });
    first.set('a', 1);
    first.set('b', 2);

    const second = registry.getOrCreate('plans', { maxEntries: 100 });
    assert.equal(second.size, 1, 'the original maxEntries still governs this cache');
  });

  test('get() and has() reflect what has been created or registered', () => {
    const registry = new CacheRegistry();
    assert.equal(registry.has('plans'), false);
    assert.equal(registry.get('plans'), undefined);

    registry.getOrCreate('plans');
    assert.equal(registry.has('plans'), true);
    assert.ok(registry.get('plans'));
  });
});

describe('CacheRegistry: register', () => {
  test('a pre-built cache is registered under its own name', () => {
    const registry = new CacheRegistry();
    const cache = new InMemoryCache<string>('sessions');

    registry.register(cache);

    assert.equal(registry.get('sessions'), cache);
  });

  test('duplicate names fail loudly', () => {
    const registry = new CacheRegistry();
    registry.register(new InMemoryCache('sessions'));

    assert.throws(() => registry.register(new InMemoryCache('sessions')), CacheError);
  });

  test('registering under a name already created via getOrCreate also fails loudly', () => {
    const registry = new CacheRegistry();
    registry.getOrCreate('plans');

    assert.throws(() => registry.register(new InMemoryCache('plans')), CacheError);
  });
});

describe('CacheRegistry: diagnostics', () => {
  test('aggregates stats across every registered cache', () => {
    const registry = new CacheRegistry();
    const a = registry.getOrCreate<string>('a');
    const b = registry.getOrCreate<string>('b');

    a.set('x', '1');
    a.get('x');
    a.get('missing');
    b.set('y', '1');
    b.set('z', '2');

    const diagnostics = registry.getDiagnostics();
    assert.equal(diagnostics.cachesRegistered, 2);
    assert.deepEqual(diagnostics.caches, ['a', 'b']);
    assert.equal(diagnostics.totalEntries, 3);
    assert.equal(diagnostics.totalHits, 1);
    assert.equal(diagnostics.totalMisses, 1);
  });

  test('an empty registry reports zeroed diagnostics', () => {
    const registry = new CacheRegistry();

    assert.deepEqual(registry.getDiagnostics(), {
      cachesRegistered: 0,
      caches: [],
      totalEntries: 0,
      totalHits: 0,
      totalMisses: 0,
      totalEvictions: 0,
      totalExpirations: 0,
    });
  });
});

describe('cache provider plugin capability', () => {
  function makeCachePlugin(cache: Cache): AgentPlugin & CacheProvider {
    return {
      metadata: {
        id: 'test.cache',
        name: 'Cache Plugin',
        version: '1.0.0',
        description: 'test',
        author: 'tests',
        capabilities: [PluginCapability.CacheProvider],
      },
      register() {},
      getCaches: () => [cache],
    };
  }

  test('contributed caches are harvested, recorded and released', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const cache = new InMemoryCache('plugin-cache');

    await loader.install(makeCachePlugin(cache));

    assert.deepEqual(loader.getCaches().map((entry) => entry.name), ['plugin-cache']);
    assert.deepEqual(
      loader.getInstallation('test.cache').contributions.caches,
      ['plugin-cache'],
    );

    await loader.uninstall('test.cache');
    assert.deepEqual(loader.getCaches(), []);
  });

  test('a contributed cache wired into the registry is reachable by name', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const cache = new InMemoryCache<string>('plugin-cache');
    await loader.install(makeCachePlugin(cache));

    const registry = new CacheRegistry();
    for (const contributed of loader.getCaches()) {
      registry.register(contributed);
    }

    registry.get('plugin-cache')?.set('k', 'v');

    assert.equal(cache.get('k'), 'v');
  });
});
