import type OpenAI from 'openai';
import { createServiceToken } from './container/ServiceDescriptor.ts';
import type { PluginRegistry, PluginLoader } from './plugins/index.ts';
import type { EventBus } from './events/EventBus.ts';
import type { AgentRegistry } from './agents/AgentRegistry.ts';
import type { MessageBus } from './communication/MessageBus.ts';
import type { DelegationManager } from './delegation/DelegationManager.ts';
import type { SupervisorAgent } from './supervisor/SupervisorAgent.ts';
import type { LlmService } from '../services/llm.service.ts';
import type { PlannerService } from '../planner/planner.service.ts';
import type { ExecutorService } from '../executor/executor.service.ts';
import type { AgentRuntimeFactory } from '../agents/agent.runtime.ts';
import type { AgentLifecycleManager } from '../agents/agent-lifecycle.ts';
import type { KnowledgeStore } from '../knowledge/knowledge-store.ts';
import type { HybridRetriever } from '../knowledge/hybrid-retriever.ts';
import type { KnowledgeRanker, RankingStrategy } from '../knowledge/knowledge-ranker.ts';
import type { EmbeddingProvider, EmbeddingService } from './embeddings/index.ts';
import type { ObservabilityService } from './observability/index.ts';
import type { TraceManager } from './tracing/index.ts';
import type { MetricsRegistry } from './metrics/index.ts';
import type { CacheRegistry } from './caching/index.ts';
import type { SecurityService } from './security/index.ts';
import type { StreamManager } from './streaming/index.ts';
import type { InteractionManager } from './interaction/index.ts';
import type { WorkflowRuntime } from './workflow/index.ts';
import type { VectorStore } from './vectorstore/index.ts';

// Every service the framework registers, in one catalog. Tokens carry the
// service type, so container.get(TOKENS.llmService) returns LlmService
// with no casts anywhere.
export const TOKENS = {
  openaiClient: createServiceToken<OpenAI>('openai-client'),
  eventBus: createServiceToken<EventBus>('event-bus'),
  agentRegistry: createServiceToken<AgentRegistry>('agent-registry'),
  messageBus: createServiceToken<MessageBus>('message-bus'),
  delegationManager: createServiceToken<DelegationManager>('delegation-manager'),
  supervisorAgent: createServiceToken<SupervisorAgent>('supervisor-agent'),
  pluginRegistry: createServiceToken<PluginRegistry>('plugin-registry'),
  pluginLoader: createServiceToken<PluginLoader>('plugin-loader'),
  llmService: createServiceToken<LlmService>('llm-service'),
  plannerService: createServiceToken<PlannerService>('planner-service'),
  executorService: createServiceToken<ExecutorService>('executor-service'),
  agentRuntimeFactory: createServiceToken<AgentRuntimeFactory>('agent-runtime-factory'),
  agentLifecycle: createServiceToken<AgentLifecycleManager>('agent-lifecycle-manager'),
  knowledgeStore: createServiceToken<KnowledgeStore>('knowledge-store'),
  embeddingProvider: createServiceToken<EmbeddingProvider>('embedding-provider'),
  embeddingService: createServiceToken<EmbeddingService>('embedding-service'),
  vectorStore: createServiceToken<VectorStore>('vector-store'),
  hybridRetriever: createServiceToken<HybridRetriever>('hybrid-retriever'),
  rankingStrategy: createServiceToken<RankingStrategy>('ranking-strategy'),
  knowledgeRanker: createServiceToken<KnowledgeRanker>('knowledge-ranker'),
  observability: createServiceToken<ObservabilityService>('observability'),
  tracing: createServiceToken<TraceManager>('tracing'),
  metrics: createServiceToken<MetricsRegistry>('metrics'),
  caching: createServiceToken<CacheRegistry>('caching'),
  security: createServiceToken<SecurityService>('security'),
  streaming: createServiceToken<StreamManager>('streaming'),
  interactions: createServiceToken<InteractionManager>('interactions'),
  workflows: createServiceToken<WorkflowRuntime>('workflows'),
} as const;
