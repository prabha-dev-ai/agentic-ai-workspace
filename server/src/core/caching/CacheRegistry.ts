import { CacheError } from './Cache.ts';
import type { Cache } from './Cache.ts';
import { InMemoryCache } from './InMemoryCache.ts';
import type { InMemoryCacheOptions } from './InMemoryCache.ts';

export interface CacheRegistryDiagnostics {
  cachesRegistered: number;
  /** Registered cache names, in registration order. */
  caches: string[];
  totalEntries: number;
  totalHits: number;
  totalMisses: number;
  totalEvictions: number;
  totalExpirations: number;
}

// The caching hub: components ask it for a named cache (get-or-create, the
// same idiom as MetricsRegistry.counter/gauge/histogram), plugins
// contribute alternative backends under their own names through the
// cache-provider capability, and getDiagnostics() aggregates stats across
// every registered cache. Mirrors the other registries deliberately —
// same duplicate-name-fails-loudly registration discipline, same
// component-scoped-lookup pattern.
export class CacheRegistry {
  private readonly caches = new Map<string, Cache>();

  /** Get the named cache, creating an in-memory one on first use. Options
   *  are only applied on creation — they're ignored on later calls for a
   *  name that already exists. */
  getOrCreate<V = unknown>(name: string, options?: InMemoryCacheOptions): Cache<V> {
    const existing = this.caches.get(name);
    if (existing) {
      return existing as Cache<V>;
    }

    const cache = new InMemoryCache<V>(name, options);
    this.caches.set(name, cache as Cache);
    return cache;
  }

  /** Register a pre-built cache (typically plugin-contributed) under its
   *  own name. Duplicate names fail loudly — silent replacement is how
   *  "which backend is this key actually in?" bugs are born. */
  register(cache: Cache): void {
    if (typeof cache.name !== 'string' || cache.name.trim() === '') {
      throw new CacheError('A cache needs a non-empty name.');
    }
    if (this.caches.has(cache.name)) {
      throw new CacheError(`A cache named "${cache.name}" is already registered.`);
    }
    this.caches.set(cache.name, cache);
  }

  get(name: string): Cache | undefined {
    return this.caches.get(name);
  }

  has(name: string): boolean {
    return this.caches.has(name);
  }

  getDiagnostics(): CacheRegistryDiagnostics {
    let totalEntries = 0;
    let totalHits = 0;
    let totalMisses = 0;
    let totalEvictions = 0;
    let totalExpirations = 0;

    for (const cache of this.caches.values()) {
      const stats = cache.getStats();
      totalEntries += stats.size;
      totalHits += stats.hits;
      totalMisses += stats.misses;
      totalEvictions += stats.evictions;
      totalExpirations += stats.expirations;
    }

    return {
      cachesRegistered: this.caches.size,
      caches: [...this.caches.keys()],
      totalEntries,
      totalHits,
      totalMisses,
      totalEvictions,
      totalExpirations,
    };
  }
}
