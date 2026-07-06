import { PluginCapability } from '../plugins/index.ts';
import type {
  AgentPlugin,
  EmbeddingProvider as EmbeddingProviderCapability,
} from '../plugins/index.ts';
import type { EmbeddingProvider } from './EmbeddingProvider.ts';

// The default embedding provider, packaged as a built-in plugin so that
// embeddings flow through the same capability pipeline as tools do — one
// discoverable catalog of everything the framework can contribute.
//
// A factory instead of a plugin object: plugins install BEFORE the
// container builds, but the provider lives IN the container (it needs the
// shared OpenAI client, which only the composition root may construct).
// The plugin therefore receives a lazy accessor and defers every provider
// touch to embed time — which is always after build().
export function createEmbeddingsPlugin(
  getProvider: () => EmbeddingProvider,
): AgentPlugin & EmbeddingProviderCapability {
  return {
    metadata: {
      id: 'core.embeddings',
      name: 'Embeddings',
      version: '1.0.0',
      description: 'Default OpenAI-compatible embedding provider.',
      author: 'Agentic AI Workspace',
      license: 'MIT',
      capabilities: [PluginCapability.EmbeddingProvider],
    },

    register(context) {
      context.log('installed');
    },

    getEmbeddingProvider() {
      return {
        get model() {
          return getProvider().model;
        },
        // async so a failing accessor becomes a rejected promise — the
        // contract every EmbeddingContribution caller relies on.
        embed: async (text: string) => getProvider().embed(text),
        embedBatch: async (texts: string[]) => getProvider().embedBatch(texts),
      };
    },
  };
}
