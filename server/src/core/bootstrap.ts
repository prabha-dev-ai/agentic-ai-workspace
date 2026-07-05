import OpenAI from 'openai';
import { env } from '../config/env.ts';
import { ServiceCollection } from './container/ServiceCollection.ts';
import { TOKENS } from './tokens.ts';
import { createLlmService } from '../services/llm.service.ts';
import { createPlannerService } from '../planner/planner.service.ts';
import { createExecutorService } from '../executor/executor.service.ts';
import { createAgentRuntimeFactory } from '../agents/agent.runtime.ts';
import { createKnowledgeStore } from '../knowledge/knowledge-store.ts';
import type { Container } from './container/Container.ts';

// The composition root: the ONE place where the framework's object graph
// is wired together. Everything else asks the container; nothing else
// constructs shared services.
export function bootstrap(): Container {
  const services = new ServiceCollection();

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
    createLlmService(container.get(TOKENS.openaiClient)),
  );

  services.registerSingleton(TOKENS.plannerService, (container) =>
    createPlannerService(container.get(TOKENS.openaiClient)),
  );

  services.registerSingleton(TOKENS.executorService, (container) =>
    createExecutorService(container.get(TOKENS.openaiClient)),
  );

  services.registerSingleton(TOKENS.agentRuntimeFactory, (container) =>
    createAgentRuntimeFactory(container.get(TOKENS.openaiClient)),
  );

  services.registerSingleton(TOKENS.knowledgeStore, () =>
    createKnowledgeStore(),
  );

  return services.build();
}
