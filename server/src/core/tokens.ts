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
import type { CheckpointManager } from './checkpoint/index.ts';
import type { VectorStore } from './vectorstore/index.ts';
import type { PgClient } from './database/PgClient.ts';
import type { RedisClient } from './caching/RedisClient.ts';
import type { AsyncKnowledgeStore } from '../knowledge/async-knowledge-store.ts';
import type { AuthService } from './auth/AuthService.ts';
import type { RateLimiter } from './auth/RateLimiter.ts';
import type {
  DistributedTransport,
  WorkerRegistry,
  RemoteTaskBridge,
  DistributedEventBridge,
  DistributedSupervisor,
  HeartbeatWatchdog,
  WorkerHeartbeatSender,
} from './distributed/index.ts';

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
  checkpoints: createServiceToken<CheckpointManager>('checkpoints'),

  // AAI-036: optional persistent-storage infrastructure. Registered only
  // when their config is present (see config/env.ts's postgres/redis
  // blocks) — resolve these with container.resolve(), not container.get(),
  // since an unconfigured deployment never registers them. vectorStore
  // above needs no new token: it stays the single VectorStore token,
  // conditionally bound to PostgresVectorStore instead of
  // InMemoryVectorStore in bootstrap.ts — the interface never changed.
  postgresPool: createServiceToken<PgClient>('postgres-pool'),
  redisClient: createServiceToken<RedisClient>('redis-client'),
  asyncKnowledgeStore: createServiceToken<AsyncKnowledgeStore>('async-knowledge-store'),

  // AAI-038: the gateway's authn/authz hub. Always registered (AuthService
  // itself always exists — see its isEnabled() doc comment); rateLimiter
  // is optional, registered only when RATE_LIMIT_WINDOW_MS/RATE_LIMIT_MAX
  // are both configured — resolve() it, not get(), same as the AAI-036
  // optional-backend tokens above.
  auth: createServiceToken<AuthService>('auth'),
  rateLimiter: createServiceToken<RateLimiter>('rate-limiter'),

  // AAI-039: distributed agent execution. Registered only when
  // DISTRIBUTED_ENABLED=true (see config/env.ts's distributed block) —
  // resolve() these, not get(), same as the AAI-036/038 optional tokens
  // above. supervisorAgent/messageBus/agentRegistry above need no new
  // tokens: messageBus stays bound to the same token, conditionally a
  // DistributedMessageBus instead of a plain MessageBus, the same
  // swappable-concrete-class idiom as vectorStore.
  distributedTransport: createServiceToken<DistributedTransport>('distributed-transport'),
  workerRegistry: createServiceToken<WorkerRegistry>('worker-registry'),
  workerHeartbeatSender: createServiceToken<WorkerHeartbeatSender>('worker-heartbeat-sender'),
  remoteTaskBridge: createServiceToken<RemoteTaskBridge>('remote-task-bridge'),
  distributedEventBridge: createServiceToken<DistributedEventBridge>('distributed-event-bridge'),
  heartbeatWatchdog: createServiceToken<HeartbeatWatchdog>('heartbeat-watchdog'),
  distributedSupervisor: createServiceToken<DistributedSupervisor>('distributed-supervisor'),
} as const;
