import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { CacheError } from './Cache.ts';
import { RedisCache } from './RedisCache.ts';
import { createRedisCachePlugin } from './RedisCachePlugin.ts';
import { CacheRegistry } from './CacheRegistry.ts';
import { PluginLoader, PluginRegistry, PluginCapability } from '../plugins/index.ts';
import type { RedisClient } from './RedisClient.ts';

// An in-memory stand-in for a real Redis server — no network, same
// injected-fake idiom as PostgresVectorStore.test.ts's fake PgClient. It
// honors TTL expiry (via a wall-clock check) so RedisCache's set/get
// round-trip through something that behaves like real Redis, not a mock
// that always says yes.
function makeFakeRedisClient(): RedisClient {
  const store = new Map<string, { value: string; expiresAt: number | undefined }>();

  function isLive(key: string): boolean {
    const entry = store.get(key);
    if (!entry) return false;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return false;
    }
    return true;
  }

  return {
    async get(key) {
      return isLive(key) ? store.get(key)!.value : null;
    },
    async set(key, value, options) {
      store.set(key, {
        value,
        expiresAt: options?.ttlMs !== undefined ? Date.now() + options.ttlMs : undefined,
      });
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
    async exists(key) {
      return isLive(key);
    },
    async keys(pattern) {
      const prefix = pattern.replace(/\*$/, '');
      return [...store.keys()].filter((key) => isLive(key) && key.startsWith(prefix));
    },
  };
}

describe('RedisCache: basic operations', () => {
  test('set then get returns the stored value', async () => {
    const cache = new RedisCache<string>('sessions', makeFakeRedisClient());
    await cache.set('a', 'apple');

    assert.equal(await cache.get('a'), 'apple');
  });

  test('values round-trip through JSON, including objects and arrays', async () => {
    const cache = new RedisCache<{ n: number; items: string[] }>('objs', makeFakeRedisClient());
    await cache.set('a', { n: 1, items: ['x', 'y'] });

    assert.deepEqual(await cache.get('a'), { n: 1, items: ['x', 'y'] });
  });

  test('get on a missing key returns undefined and counts a miss', async () => {
    const cache = new RedisCache('sessions', makeFakeRedisClient());

    assert.equal(await cache.get('missing'), undefined);
    assert.equal((await cache.getStats()).misses, 1);
  });

  test('has reflects presence', async () => {
    const cache = new RedisCache('sessions', makeFakeRedisClient());
    await cache.set('a', 'apple');

    assert.equal(await cache.has('a'), true);
    assert.equal(await cache.has('missing'), false);
  });

  test('delete removes an entry and reports whether it existed', async () => {
    const cache = new RedisCache('sessions', makeFakeRedisClient());
    await cache.set('a', 'apple');

    assert.equal(await cache.delete('a'), true);
    assert.equal(await cache.delete('a'), false);
    assert.equal(await cache.has('a'), false);
  });

  test('clear empties only this cache\'s namespace', async () => {
    const client = makeFakeRedisClient();
    const a = new RedisCache('a', client);
    const b = new RedisCache('b', client);
    await a.set('k', '1');
    await b.set('k', '2');

    await a.clear();

    assert.equal(await a.has('k'), false);
    assert.equal(await b.has('k'), true, 'a different cache namespace is untouched');
  });

  test('size reflects the current entry count', async () => {
    const cache = new RedisCache('sessions', makeFakeRedisClient());
    await cache.set('a', '1');
    await cache.set('b', '2');

    assert.equal(await cache.size(), 2);
  });

  test('an empty cache name is rejected', () => {
    assert.throws(() => new RedisCache('  ', makeFakeRedisClient()), CacheError);
  });

  test('an undefined value is rejected as not JSON-serializable', async () => {
    const cache = new RedisCache('sessions', makeFakeRedisClient());
    await assert.rejects(() => cache.set('a', undefined), CacheError);
  });
});

describe('RedisCache: namespacing', () => {
  test('two caches with different names never collide on the same key', async () => {
    const client = makeFakeRedisClient();
    const sessions = new RedisCache<string>('sessions', client);
    const plans = new RedisCache<string>('plans', client);

    await sessions.set('k', 'session-value');
    await plans.set('k', 'plan-value');

    assert.equal(await sessions.get('k'), 'session-value');
    assert.equal(await plans.get('k'), 'plan-value');
  });
});

describe('RedisCache: TTL', () => {
  test('an entry with a TTL expires and is treated as a miss afterward', async () => {
    const cache = new RedisCache<string>('sessions', makeFakeRedisClient());
    await cache.set('a', 'apple', { ttlMs: 5 });

    assert.equal(await cache.get('a'), 'apple');
    await sleep(15);

    assert.equal(await cache.get('a'), undefined);
  });

  test('a cache-level default TTL applies when set() does not specify one', async () => {
    const cache = new RedisCache<string>('sessions', makeFakeRedisClient(), { defaultTtlMs: 5 });
    await cache.set('a', 'apple');

    await sleep(15);
    assert.equal(await cache.get('a'), undefined);
  });
});

describe('RedisCache: statistics', () => {
  test('hits, misses, sets and deletes are tallied; evictions/expirations are always 0', async () => {
    const cache = new RedisCache<string>('sessions', makeFakeRedisClient());

    await cache.set('a', '1');
    await cache.get('a');
    await cache.get('missing');
    await cache.delete('a');

    const stats = await cache.getStats();
    assert.equal(stats.sets, 1);
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
    assert.equal(stats.deletes, 1);
    assert.equal(stats.evictions, 0, 'Redis-side eviction is not observable from the client');
    assert.equal(stats.expirations, 0, 'Redis-side TTL sweep is not observable from the client');
  });
});

describe('async cache provider plugin capability', () => {
  test('a Redis-backed cache is harvested and reachable through CacheRegistry', async () => {
    const client = makeFakeRedisClient();
    const cache = new RedisCache<string>('redis', client);
    const loader = new PluginLoader(new PluginRegistry());

    await loader.install(createRedisCachePlugin(cache));

    assert.deepEqual(loader.getAsyncCaches().map((c) => c.name), ['redis']);
    assert.equal(
      loader.getInstallation('core.redis-cache').contributions.asyncCaches[0],
      'redis',
    );

    const registry = new CacheRegistry();
    for (const contributed of loader.getAsyncCaches()) {
      registry.registerAsync(contributed);
    }

    await registry.getAsync('redis')?.set('k', 'v');
    assert.equal(await cache.get('k'), 'v');
  });

  test('duplicate async cache names across plugins fail loudly', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    const first = new RedisCache<string>('shared', makeFakeRedisClient());
    const second = new RedisCache<string>('shared', makeFakeRedisClient());

    await loader.install(createRedisCachePlugin(first));

    const other = createRedisCachePlugin(second);
    (other.metadata as { id: string }).id = 'other.redis-cache';

    await assert.rejects(() => loader.install(other));
  });

  test('uninstall removes the contributed async cache', async () => {
    const loader = new PluginLoader(new PluginRegistry());
    await loader.install(createRedisCachePlugin(new RedisCache('redis', makeFakeRedisClient())));

    await loader.uninstall('core.redis-cache');

    assert.deepEqual(loader.getAsyncCaches(), []);
  });
});

describe('PluginCapability.AsyncCacheProvider', () => {
  test('is declared on the plugin metadata', () => {
    const plugin = createRedisCachePlugin(new RedisCache('redis', makeFakeRedisClient()));
    assert.deepEqual(plugin.metadata.capabilities, [PluginCapability.AsyncCacheProvider]);
  });
});
