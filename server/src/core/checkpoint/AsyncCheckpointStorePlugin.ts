import { PluginCapability } from '../plugins/index.ts';
import type {
  AgentPlugin,
  AsyncCheckpointStoreProvider as AsyncCheckpointStoreProviderCapability,
} from '../plugins/index.ts';
import type { AsyncCheckpointStore } from './AsyncCheckpointStore.ts';
import type { Checkpoint } from './Checkpoint.ts';

// The Postgres checkpoint store, packaged as a built-in plugin — same
// lazy-accessor idiom as core/checkpoint's sync CheckpointStoreProvider
// contribution and core/vectorstore/VectorStorePlugin.ts: single
// swappable backend (a process wants ONE active async checkpoint
// destination), contributed through the plugin pipeline for the same
// discoverability every other backend gets.
export function createAsyncCheckpointStorePlugin(
  getStore: () => AsyncCheckpointStore,
): AgentPlugin & AsyncCheckpointStoreProviderCapability {
  return {
    metadata: {
      id: 'core.postgres-checkpoint-store',
      name: 'Postgres Checkpoint Store',
      version: '1.0.0',
      description: 'Postgres-backed async checkpoint store.',
      author: 'Agentic AI Workspace',
      license: 'MIT',
      capabilities: [PluginCapability.AsyncCheckpointStoreProvider],
    },

    register(context) {
      context.log('installed');
    },

    getAsyncCheckpointStore() {
      return {
        get name() {
          return getStore().name;
        },
        save: async (subjectId: string, data: unknown, metadata?: Record<string, unknown>) =>
          getStore().save(subjectId, data, metadata) as Promise<Checkpoint>,
        getLatest: async (subjectId: string) =>
          getStore().getLatest(subjectId) as Promise<Checkpoint | undefined>,
        list: async (subjectId: string) => getStore().list(subjectId) as Promise<Checkpoint[]>,
        clear: async (subjectId: string) => getStore().clear(subjectId),
        getStats: async () => getStore().getStats(),
      };
    },
  };
}
