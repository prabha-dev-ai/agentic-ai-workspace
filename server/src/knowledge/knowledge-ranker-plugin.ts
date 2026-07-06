import { PluginCapability } from '../core/plugins/index.ts';
import type { AgentPlugin, RankingStrategyProvider } from '../core/plugins/index.ts';
import type { RankingCandidate, RankingStrategy } from './knowledge-ranker.ts';

// The default weighted ranking strategy, contributed through the plugin
// pipeline so alternative strategies (recency-based, LLM rerankers) are
// first-class citizens next to it. Same lazy-accessor pattern as the
// other built-ins: the real strategy is container-owned and does not
// exist yet at install time.
//
// The contribution name is static ('weighted') because named
// contributions are harvested at install time, before the container —
// and therefore the strategy instance — exists.
export function createKnowledgeRankerPlugin(
  getStrategy: () => RankingStrategy,
): AgentPlugin & RankingStrategyProvider {
  return {
    metadata: {
      id: 'core.knowledge-ranker',
      name: 'Knowledge Ranker',
      version: '1.0.0',
      description: 'Default weighted, explainable ranking strategy.',
      author: 'Agentic AI Workspace',
      license: 'MIT',
      capabilities: [PluginCapability.RankingStrategyProvider],
    },

    register(context) {
      context.log('installed');
    },

    getRankingStrategies() {
      return [
        {
          name: 'weighted',
          // async so a failing accessor becomes a rejected promise.
          score: async (query: string, candidates: RankingCandidate[]) =>
            getStrategy().score(query, candidates),
        },
      ];
    },
  };
}
