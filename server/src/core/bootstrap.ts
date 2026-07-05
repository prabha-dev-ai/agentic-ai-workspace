import OpenAI from 'openai';
import { env } from '../config/env.ts';
import { ServiceCollection } from './container/ServiceCollection.ts';
import { PluginRegistry, PluginLoader } from './plugins/index.ts';
import { TOKENS } from './tokens.ts';
import { createLlmService } from '../services/llm.service.ts';
import { createPlannerService } from '../planner/planner.service.ts';
import { createExecutorService } from '../executor/executor.service.ts';
import { createAgentRuntimeFactory } from '../agents/agent.runtime.ts';
import { createKnowledgeStore } from '../knowledge/knowledge-store.ts';
import { timePlugin } from '../plugins/time.plugin.ts';
import type { AgentPlugin } from './plugins/index.ts';
import type { Container } from './container/Container.ts';

// Every plugin that ships with the framework. Installation order matters
// only for tool-name collisions, which the loader rejects loudly.
const BUILTIN_PLUGINS: AgentPlugin[] = [timePlugin];

// The composition root: the ONE place where the framework's object graph
// is wired together. Async because plugin installation runs register()
// hooks, which may be async.
export async function bootstrap(): Promise<Container> {
  // Plugins install before the container builds, so services can receive
  // the loader (the aggregated tool catalog) as an ordinary dependency.
  const pluginRegistry = new PluginRegistry();
  const pluginLoader = new PluginLoader(pluginRegistry);

  for (const plugin of BUILTIN_PLUGINS) {
    await pluginLoader.install(plugin);
  }

  const services = new ServiceCollection();

  services.registerSingleton(TOKENS.pluginRegistry, () => pluginRegistry);
  services.registerSingleton(TOKENS.pluginLoader, () => pluginLoader);

  // The single OpenAI client for the whole process, created lazily on
  // first resolution. The container is the only owner — no module-level
  // client exists anywhere anymore.
  services.registerSingleton(TOKENS.openaiClient, () => {
    if (!env.llm.apiKey) {
      throw new Error(
        'LLM_API_KEY is not set. Add it to server/.env before starting the server.',
      );
    }

    return new OpenAI({
      apiKey: env.llm.apiKey,
      baseURL: env.llm.baseUrl,
    });
  });

  services.registerSingleton(TOKENS.llmService, (container) =>
    createLlmService(
      container.get(TOKENS.openaiClient),
      container.get(TOKENS.pluginLoader),
    ),
  );

  services.registerSingleton(TOKENS.plannerService, (container) =>
    createPlannerService(container.get(TOKENS.openaiClient)),
  );

  services.registerSingleton(TOKENS.executorService, (container) =>
    createExecutorService(
      container.get(TOKENS.openaiClient),
      container.get(TOKENS.pluginLoader),
    ),
  );

  services.registerSingleton(TOKENS.agentRuntimeFactory, (container) =>
    createAgentRuntimeFactory(
      container.get(TOKENS.openaiClient),
      container.get(TOKENS.pluginLoader),
    ),
  );

  services.registerSingleton(TOKENS.knowledgeStore, () =>
    createKnowledgeStore(),
  );

  return services.build();
}
