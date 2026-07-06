import { PluginCapability } from '../plugins/index.ts';
import type {
  AgentPlugin,
  VectorStoreProvider as VectorStoreProviderCapability,
} from '../plugins/index.ts';
import type { SearchOptions } from './SearchOptions.ts';
import type { VectorDocument } from './VectorDocument.ts';
import type { VectorStore } from './VectorStore.ts';

// The default vector store, packaged as a built-in plugin — the same
// pattern (and the same reason) as createEmbeddingsPlugin: the shared
// store is a container-owned singleton, and the container does not
// exist yet when plugins install. The plugin receives a lazy accessor
// and defers every store touch to call time, which is always after
// build(). Data added through the plugin contribution and data added
// through DI land in the SAME store.
export function createVectorStorePlugin(
  getStore: () => VectorStore,
): AgentPlugin & VectorStoreProviderCapability {
  return {
    metadata: {
      id: 'core.vectorstore',
      name: 'Vector Store',
      version: '1.0.0',
      description: 'Default in-memory vector store.',
      author: 'Agentic AI Workspace',
      license: 'MIT',
      capabilities: [PluginCapability.VectorStoreProvider],
    },

    register(context) {
      context.log('installed');
    },

    getVectorStore() {
      // async so a failing accessor becomes a rejected promise — the
      // contract every VectorStoreContribution caller relies on.
      return {
        add: async (document: VectorDocument) => getStore().add(document),
        addBatch: async (documents: VectorDocument[]) =>
          getStore().addBatch(documents),
        update: async (document: VectorDocument) => getStore().update(document),
        delete: async (id: string) => getStore().delete(id),
        get: async (id: string) => getStore().get(id),
        search: async (vector: number[], options?: SearchOptions) =>
          getStore().search(vector, options),
        clear: async () => getStore().clear(),
      };
    },
  };
}
