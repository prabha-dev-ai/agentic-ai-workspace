export class CacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface CacheEntryOptions {
  /** Time-to-live in milliseconds. Omit for no expiry. */
  ttlMs?: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  /** Entries dropped to stay within maxEntries — capacity pressure, not TTL. */
  evictions: number;
  /** Entries dropped because their TTL had passed. */
  expirations: number;
  size: number;
}

// The cache abstraction every backend implements — in-memory today,
// swappable later (Redis, a distributed cache) through the cache-provider
// plugin capability without touching call sites. V defaults to unknown so
// the interface mirrors cleanly into the plugin capability contract,
// which cannot express a generic.
export interface Cache<V = unknown> {
  readonly name: string;
  readonly size: number;

  get(key: string): V | undefined;
  set(key: string, value: V, options?: CacheEntryOptions): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;

  getStats(): CacheStats;
}
