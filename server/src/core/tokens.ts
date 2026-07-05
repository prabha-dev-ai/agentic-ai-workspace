import type OpenAI from 'openai';
import { createServiceToken } from './container/ServiceDescriptor.ts';
import type { PluginRegistry, PluginLoader } from './plugins/index.ts';
import type { EventBus } from './events/EventBus.ts';
import type { AgentRegistry } from './agents/AgentRegistry.ts';
import type { LlmService } from '../services/llm.service.ts';
import type { PlannerService } from '../planner/planner.service.ts';
import type { ExecutorService } from '../executor/executor.service.ts';
import type { AgentRuntimeFactory } from '../agents/agent.runtime.ts';
import type { AgentLifecycleManager } from '../agents/agent-lifecycle.ts';
import type { KnowledgeStore } from '../knowledge/knowledge-store.ts';

// Every service the framework registers, in one catalog. Tokens carry the
// service type, so container.get(TOKENS.llmService) returns LlmService
// with no casts anywhere.
export const TOKENS = {
  openaiClient: createServiceToken<OpenAI>('openai-client'),
  eventBus: createServiceToken<EventBus>('event-bus'),
  agentRegistry: createServiceToken<AgentRegistry>('agent-registry'),
  pluginRegistry: createServiceToken<PluginRegistry>('plugin-registry'),
  pluginLoader: createServiceToken<PluginLoader>('plugin-loader'),
  llmService: createServiceToken<LlmService>('llm-service'),
  plannerService: createServiceToken<PlannerService>('planner-service'),
  executorService: createServiceToken<ExecutorService>('executor-service'),
  agentRuntimeFactory: createServiceToken<AgentRuntimeFactory>('agent-runtime-factory'),
  agentLifecycle: createServiceToken<AgentLifecycleManager>('agent-lifecycle-manager'),
  knowledgeStore: createServiceToken<KnowledgeStore>('knowledge-store'),
} as const;
