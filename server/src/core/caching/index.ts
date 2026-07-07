// The caching API surface. Consumers import from this barrel only — the
// individual files are implementation layout.

export { CacheError } from './Cache.ts';
export type { Cache, CacheEntryOptions, CacheStats } from './Cache.ts';
export { InMemoryCache } from './InMemoryCache.ts';
export type { InMemoryCacheOptions } from './InMemoryCache.ts';
export { CacheRegistry } from './CacheRegistry.ts';
export type { CacheRegistryDiagnostics } from './CacheRegistry.ts';
