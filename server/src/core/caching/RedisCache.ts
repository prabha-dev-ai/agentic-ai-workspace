import { CacheError } from './Cache.ts';
import type { AsyncCache } from './AsyncCache.ts';
import type { CacheStats } from './Cache.ts';
import type { RedisClient } from './RedisClient.ts';

export interface RedisCacheOptions {
  /** Default TTL in ms applied when set() doesn't specify one. Omit for no expiry by default. */
  defaultTtlMs?: number;
}

// Redis-backed AsyncCache: every entry lives under `${name}:${key}` in
// the shared Redis keyspace, so multiple named caches can coexist on one
// Redis database without collisions — the same purpose InMemoryCache's
// separate Map-per-instance serves, just namespaced by prefix instead of
// by object identity.
//
// Values are JSON-serialized: Redis stores strings, Cache<V> stores any
// V. A value that cannot round-trip through JSON (functions, circular
// references) fails at set() with a clear error rather than silently
// corrupting.
//
// getStats() is honest about what a Redis client can and cannot observe:
// hits/misses/sets/deletes are counted client-side (every call passes
// through this instance), but evictions (Redis's own maxmemory-policy)
// and expirations (Redis's own TTL sweep) are NOT visible to a client
// that didn't perform them — both are always reported as 0, documented
// here rather than faked.
export class RedisCache<V = unknown> implements AsyncCache<V> {
  readonly name: string;
  private readonly client: RedisClient;
  private readonly defaultTtlMs: number | undefined;
  private readonly prefix: string;

  private hits = 0;
  private misses = 0;
  private sets = 0;
  private deletes = 0;

  constructor(name: string, client: RedisClient, options: RedisCacheOptions = {}) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new CacheError('A cache needs a non-empty name.');
    }
    this.name = name;
    this.client = client;
    this.defaultTtlMs = options.defaultTtlMs;
    this.prefix = `cache:${name}:`;
  }

  async get(key: string): Promise<V | undefined> {
    const raw = await this.client.get(this.namespaced(key));

    if (raw === null) {
      this.misses++;
      return undefined;
    }

    this.hits++;
    return JSON.parse(raw) as V;
  }

  async set(key: string, value: V, options: { ttlMs?: number } = {}): Promise<void> {
    const ttlMs = options.ttlMs ?? this.defaultTtlMs;

    // JSON.stringify(undefined) returns the VALUE undefined at runtime,
    // not a string, despite its string return type — the one case the
    // try/catch below cannot detect on its own.
    if (value === undefined) {
      throw new CacheError(`Cache "${this.name}": value for key "${key}" is not JSON-serializable.`);
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new CacheError(`Cache "${this.name}": value for key "${key}" is not JSON-serializable.`);
    }

    await this.client.set(this.namespaced(key), serialized, ttlMs !== undefined ? { ttlMs } : undefined);
    this.sets++;
  }

  async has(key: string): Promise<boolean> {
    return this.client.exists(this.namespaced(key));
  }

  async delete(key: string): Promise<boolean> {
    const removed = await this.client.del(this.namespaced(key));
    if (removed > 0) {
      this.deletes++;
    }
    return removed > 0;
  }

  async clear(): Promise<void> {
    const keys = await this.client.keys(`${this.prefix}*`);
    for (const key of keys) {
      await this.client.del(key);
    }
  }

  async size(): Promise<number> {
    const keys = await this.client.keys(`${this.prefix}*`);
    return keys.length;
  }

  async getStats(): Promise<CacheStats> {
    return {
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      deletes: this.deletes,
      // Not observable from a Redis client — see class comment.
      evictions: 0,
      expirations: 0,
      size: await this.size(),
    };
  }

  private namespaced(key: string): string {
    return `${this.prefix}${key}`;
  }
}
