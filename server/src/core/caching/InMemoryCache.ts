import { CacheError } from './Cache.ts';
import type { Cache, CacheEntryOptions, CacheStats } from './Cache.ts';

export interface InMemoryCacheOptions {
  /** Default TTL in ms applied when set() doesn't specify one. Omit for no expiry by default. */
  defaultTtlMs?: number;
  /** Max entries retained; least-recently-used evicted first. Omit for unbounded. */
  maxEntries?: number;
}

interface Entry<V> {
  value: V;
  /** Epoch ms this entry stops being valid. Undefined means it never expires. */
  expiresAt: number | undefined;
}

// The default cache backend: an in-process Map with TTL expiry and
// size-bounded LRU eviction. A `Map` already preserves insertion order,
// so re-inserting a key on every read/write is the whole LRU
// implementation — the first key in iteration order is always the
// least-recently-used one.
export class InMemoryCache<V = unknown> implements Cache<V> {
  readonly name: string;
  private readonly entries = new Map<string, Entry<V>>();
  private readonly defaultTtlMs: number | undefined;
  private readonly maxEntries: number | undefined;

  private hits = 0;
  private misses = 0;
  private sets = 0;
  private deletes = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(name: string, options: InMemoryCacheOptions = {}) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new CacheError('A cache needs a non-empty name.');
    }
    if (options.maxEntries !== undefined && options.maxEntries <= 0) {
      throw new CacheError(
        `Cache "${name}" needs a positive maxEntries, got ${options.maxEntries}.`,
      );
    }

    this.name = name;
    this.defaultTtlMs = options.defaultTtlMs;
    this.maxEntries = options.maxEntries;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);

    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (this.isExpired(entry)) {
      this.entries.delete(key);
      this.expirations++;
      this.misses++;
      return undefined;
    }

    // Touch: move to the end (most-recently-used) for LRU eviction order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: V, options: CacheEntryOptions = {}): void {
    const ttlMs = options.ttlMs ?? this.defaultTtlMs;
    const expiresAt = ttlMs !== undefined ? Date.now() + ttlMs : undefined;

    // Reset position so a re-set counts as freshly used, same as a read.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt });
    this.sets++;

    this.evictIfOverCapacity();
  }

  has(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    if (this.isExpired(entry)) {
      this.entries.delete(key);
      this.expirations++;
      return false;
    }
    return true;
  }

  delete(key: string): boolean {
    const deleted = this.entries.delete(key);
    if (deleted) {
      this.deletes++;
    }
    return deleted;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  getStats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      deletes: this.deletes,
      evictions: this.evictions,
      expirations: this.expirations,
      size: this.entries.size,
    };
  }

  private isExpired(entry: Entry<V>): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= Date.now();
  }

  private evictIfOverCapacity(): void {
    if (this.maxEntries === undefined) {
      return;
    }

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.entries.delete(oldestKey);
      this.evictions++;
    }
  }
}
