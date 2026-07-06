import OpenAI from 'openai';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.ts';
import { ServiceCollection } from './container/ServiceCollection.ts';
import { EventBus } from './events/EventBus.ts';
import { AgentRegistry } from './agents/AgentRegistry.ts';
import { MessageBus } from './communication/MessageBus.ts';
import { DelegationManager } from './delegation/DelegationManager.ts';
import { SupervisorAgent } from './supervisor/SupervisorAgent.ts';
import { PluginRegistry, PluginLoader, discoverPlugins } from './plugins/index.ts';
import {
  EmbeddingService,
  OpenAIEmbeddingProvider,
  createEmbeddingsPlugin,
} from './embeddings/index.ts';
import { TOKENS } from './tokens.ts';
import { createLlmService } from '../services/llm.service.ts';
import { createPlannerService } from '../planner/planner.service.ts';
import { createExecutorService } from '../executor/executor.service.ts';
import { createAgentRuntimeFactory } from '../agents/agent.runtime.ts';
import { createAgentLifecycleManager } from '../agents/agent-lifecycle.ts';
import { createKnowledgeStore } from '../knowledge/knowledge-store.ts';
import type { Container } from './container/Container.ts';

// Plugins live next to the running code: src/plugins/ in development,
// dist/plugins/ in production. Dropping a *.plugin file there is the
// whole act of adding a plugin — no import list to maintain.
const DEFAULT_PLUGIN_DIRECTORY = fileURLToPath(
  new URL('../plugins/', import.meta.url),
);

export interface BootstrapOptions {
  /** Override the plugin directory (used by tests and embedders). */
  pluginDirectory?: string;
}

// The composition root: the ONE place where the framework's object graph
// is wired together. Async because plugin discovery imports modules and
// installation runs register() hooks, which may be async.
export async function bootstrap(
  options: BootstrapOptions = {},
): Promise<Container> {
  // The bus exists before anything else so installation events are never
  // missed by early subscriber plugins.
  const eventBus = new EventBus();

  // Plugins install before the container builds, so services can receive
  // the loader (the aggregated tool catalog) as an ordinary dependency.
  const pluginRegistry = new PluginRegistry();
  const pluginLoader = new PluginLoader(pluginRegistry, eventBus);

  const plugins = await discoverPlugins(
    options.pluginDirectory ?? DEFAULT_PLUGIN_DIRECTORY,
  );

  for (const plugin of plugins) {
    await pluginLoader.install(plugin);
  }

  // The default embedding provider is a built-in plugin, installed
  // programmatically rather than discovered: it cannot construct its own
  // OpenAI client (the composition root owns the only client), and the
  // container that holds the client does not exist yet at install time.
  // The plugin gets a lazy accessor instead — safe, because embeddings
  // are only requested after bootstrap has returned the built container.
  let builtContainer: Container | undefined;

  await pluginLoader.install(
    createEmbeddingsPlugin(() => {
      if (!builtContainer) {
        throw new Error('Embeddings are unavailable until bootstrap completes.');
      }
      return builtContainer.get(TOKENS.embeddingProvider);
    }),
  );

  const services = new ServiceCollection();

  services.registerSingleton(TOKENS.eventBus, () => eventBus);

  services.registerSingleton(TOKENS.messageBus, (container) =>
    new MessageBus(container.get(TOKENS.eventBus)),
  );

  services.registerSingleton(TOKENS.agentRegistry, (container) =>
    new AgentRegistry(
      container.get(TOKENS.eventBus),
      container.get(TOKENS.messageBus),
    ),
  );

  services.registerSingleton(TOKENS.delegationManager, (container) =>
    new DelegationManager({
      agentRegistry: container.get(TOKENS.agentRegistry),
      messageBus: container.get(TOKENS.messageBus),
      eventBus: container.get(TOKENS.eventBus),
    }),
  );

  services.registerSingleton(TOKENS.supervisorAgent, (container) =>
    new SupervisorAgent({
      agentRegistry: container.get(TOKENS.agentRegistry),
      delegationManager: container.get(TOKENS.delegationManager),
      eventBus: container.get(TOKENS.eventBus),
    }),
  );
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
      container.get(TOKENS.eventBus),
      container.get(TOKENS.agentRegistry),
    ),
  );

  services.registerSingleton(TOKENS.agentLifecycle, (container) =>
    createAgentLifecycleManager(container.get(TOKENS.agentRuntimeFactory)),
  );

  services.registerSingleton(TOKENS.knowledgeStore, () =>
    createKnowledgeStore(),
  );

  // NOTE: OpenRouter does not serve /embeddings — the default provider
  // needs an OpenAI-compatible base URL that does (see EmbeddingModel.ts).
  services.registerSingleton(TOKENS.embeddingProvider, (container) =>
    new OpenAIEmbeddingProvider(container.get(TOKENS.openaiClient)),
  );

  services.registerSingleton(TOKENS.embeddingService, (container) =>
    new EmbeddingService(container.get(TOKENS.embeddingProvider)),
  );

  // ServiceProvider plugins contribute services last, into the same
  // collection — duplicate protection guards them against core tokens
  // (and each other) before the container is frozen by build().
  pluginLoader.registerServices(services);

  builtContainer = services.build();
  return builtContainer;
}
