import type { CacheStats } from './Cache.ts';

// The async sibling of Cache<V> (AAI-036): a NEW, additive interface, not
// a change to Cache. Cache's get/set/has/delete/clear are synchronous —
// every existing caller (CacheRegistry.getOrCreate, every consumer that
// holds a Cache reference) calls them without awaiting. A real network
// cache (Redis) cannot honor that: there is no synchronous Redis client
// in Node. Rather than fake synchronicity with a write-behind mirror that
// can silently lose the most recent write on crash, AsyncCache is a
// separate, explicitly-awaited contract that callers opt into — see
// docs/architecture/adr for AAI-036, "Design Decisions" for the
// alternative considered and why this one was chosen. `size` becomes a
// method (not a property) for the same reason getStats() is async here.
export interface AsyncCache<V = unknown> {
  readonly name: string;

  get(key: string): Promise<V | undefined>;
  set(key: string, value: V, options?: { ttlMs?: number }): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
  size(): Promise<number>;

  getStats(): Promise<CacheStats>;
}
