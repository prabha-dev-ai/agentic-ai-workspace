import { PluginCapability } from '../plugins/index.ts';
import type { AgentPlugin, AsyncCacheProvider } from '../plugins/index.ts';
import type { AsyncCache } from './AsyncCache.ts';

// The default Redis cache, packaged as a built-in plugin. UNLIKE
// createVectorStorePlugin/createEmbeddingsPlugin, this takes the cache
// directly rather than a lazy accessor: those two use a lazy accessor
// because they're single-swappable-backend capabilities the container
// circularly depends on (the plugin installs before the container that
// will hold the "real" instance exists). AsyncCacheProvider is a NAMED
// catalog instead — PluginLoader needs `.name` immediately, during
// install-time harvesting/dedup, not deferred to call time — and
// RedisCache has no such circular dependency: it only needs a RedisClient,
// which bootstrap already has in hand before any plugin installs.
export function createRedisCachePlugin(
  cache: AsyncCache,
): AgentPlugin & AsyncCacheProvider {
  return {
    metadata: {
      id: 'core.redis-cache',
      name: 'Redis Cache',
      version: '1.0.0',
      description: 'Redis-backed async cache provider.',
      author: 'Agentic AI Workspace',
      license: 'MIT',
      capabilities: [PluginCapability.AsyncCacheProvider],
    },

    register(context) {
      context.log('installed');
    },

    getAsyncCaches() {
      return [
        {
          name: cache.name,
          get: async (key: string) => cache.get(key),
          set: async (key: string, value: unknown, options?: { ttlMs?: number }) =>
            cache.set(key, value, options),
          has: async (key: string) => cache.has(key),
          delete: async (key: string) => cache.delete(key),
          clear: async () => cache.clear(),
          size: async () => cache.size(),
          getStats: async () => cache.getStats(),
        },
      ];
    },
  };
}
