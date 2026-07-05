import { openaiClient } from '../config/openai-client.ts';
import { ServiceCollection } from './container/ServiceCollection.ts';
import { TOKENS } from './tokens.ts';
import { createLlmService } from '../services/llm.service.ts';
import { createPlannerService } from '../planner/planner.service.ts';
import { createExecutorService } from '../executor/executor.service.ts';
import { createKnowledgeStore } from '../knowledge/knowledge-store.ts';
import type { Container } from './container/Container.ts';

// The composition root: the ONE place where the framework's object graph
// is wired together. Everything else asks the container; nothing else
// constructs shared services.
export function bootstrap(): Container {
  const services = new ServiceCollection();

  // The single OpenAI client for the whole process. config/openai-client
  // owns creation and the API-key guard; registering it here lets every
  // service receive it as a dependency instead of importing it.
  services.registerSingleton(TOKENS.openaiClient, () => openaiClient);

  services.registerSingleton(TOKENS.llmService, (container) =>
    createLlmService(container.get(TOKENS.openaiClient)),
  );

  services.registerSingleton(TOKENS.plannerService, (container) =>
    createPlannerService(container.get(TOKENS.openaiClient)),
  );

  services.registerSingleton(TOKENS.executorService, (container) =>
    createExecutorService(container.get(TOKENS.openaiClient)),
  );

  services.registerSingleton(TOKENS.knowledgeStore, () =>
    createKnowledgeStore(),
  );

  return services.build();
}
