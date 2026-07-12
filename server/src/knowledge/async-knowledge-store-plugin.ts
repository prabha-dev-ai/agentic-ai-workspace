import { PluginCapability } from '../core/plugins/index.ts';
import type {
  AgentPlugin,
  AsyncKnowledgeStoreProvider as AsyncKnowledgeStoreProviderCapability,
} from '../core/plugins/index.ts';
import type { AsyncKnowledgeStore } from './async-knowledge-store.ts';

// The Postgres knowledge store, packaged as a built-in plugin — same
// lazy-accessor, single-swappable-backend idiom as
// core/vectorstore/VectorStorePlugin.ts: a process wants one active async
// knowledge destination, contributed through the plugin pipeline for the
// same discoverability every other backend gets.
export function createAsyncKnowledgeStorePlugin(
  getStore: () => AsyncKnowledgeStore,
): AgentPlugin & AsyncKnowledgeStoreProviderCapability {
  return {
    metadata: {
      id: 'core.postgres-knowledge-store',
      name: 'Postgres Knowledge Store',
      version: '1.0.0',
      description: 'Postgres-backed async knowledge store.',
      author: 'Agentic AI Workspace',
      license: 'MIT',
      capabilities: [PluginCapability.AsyncKnowledgeStoreProvider],
    },

    register(context) {
      context.log('installed');
    },

    getAsyncKnowledgeStore() {
      return {
        add: async (document) => getStore().add(document),
        getAll: async () => getStore().getAll(),
        getById: async (id: string) => getStore().getById(id),
      };
    },
  };
}
