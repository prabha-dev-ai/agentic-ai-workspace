import { PluginCapability } from '../core/plugins/index.ts';
import type { AgentPlugin, RetrieverProvider } from '../core/plugins/index.ts';
import type { HybridRetriever } from './hybrid-retriever.ts';

// Hybrid retrieval enters the plugin pipeline through the EXISTING
// retriever-provider capability — no new capability needed, because a
// hybrid retriever is just a retriever. Same lazy-accessor pattern as
// the embeddings and vector store built-ins: the real retriever is a
// container-owned singleton that does not exist yet at install time.
export function createHybridRetrieverPlugin(
  getRetriever: () => HybridRetriever,
): AgentPlugin & RetrieverProvider {
  return {
    metadata: {
      id: 'core.hybrid-retriever',
      name: 'Hybrid Retriever',
      version: '1.0.0',
      description: 'Combined keyword + vector retrieval over the knowledge base.',
      author: 'Agentic AI Workspace',
      license: 'MIT',
      capabilities: [PluginCapability.RetrieverProvider],
    },

    register(context) {
      context.log('installed');
    },

    getRetrievers() {
      return [
        {
          name: 'hybrid',
          // The contribution contract returns ranked context strings;
          // callers who need scores use the HybridRetriever from DI.
          retrieve: async (query: string) => {
            const results = await getRetriever().retrieve(query);
            return results.map((result) => result.text);
          },
        },
      ];
    },
  };
}
