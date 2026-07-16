import OpenAI from 'openai';
// AAI-036: the composition root also owns Postgres/Redis client
// construction, mirroring the pre-existing OpenAI-client-ownership rule
// (core/architecture.test.ts) — extended in this story to cover the two
// new external clients the persistent-storage providers depend on.
import { Pool } from 'pg';
import { createClient } from 'redis';
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
import {
  InMemoryVectorStore,
  PostgresVectorStore,
  createVectorStorePlugin,
} from './vectorstore/index.ts';
import { ConsoleLogSink, ObservabilityService } from './observability/index.ts';
import type { LogLevel } from './observability/index.ts';
import { ConsoleSpanExporter, TraceManager } from './tracing/index.ts';
import { ConsoleMetricExporter, MetricsRegistry } from './metrics/index.ts';
import { CacheRegistry, RedisCache, createRedisCachePlugin } from './caching/index.ts';
import { ApiKeyProvider, SecurityService } from './security/index.ts';
import { ApiKeyStore, AuthService, JwtService, RateLimiter } from './auth/index.ts';
import { StreamManager } from './streaming/index.ts';
import { InteractionManager } from './interaction/index.ts';
import { WorkflowRuntime } from './workflow/index.ts';
import {
  CheckpointManager,
  PostgresCheckpointStore,
  createAsyncCheckpointStorePlugin,
} from './checkpoint/index.ts';
import { PostgresKnowledgeStore } from '../knowledge/postgres-knowledge-store.ts';
import { createAsyncKnowledgeStorePlugin } from '../knowledge/async-knowledge-store-plugin.ts';
import {
  DistributedEventBridge,
  DistributedMessageBus,
  DistributedSupervisor,
  HeartbeatWatchdog,
  InMemoryDistributedTransport,
  RedisDistributedTransport,
  RemoteTaskBridge,
  WorkerHeartbeatSender,
  WorkerRegistry,
} from './distributed/index.ts';
import type { DistributedTransport, PubSubClient } from './distributed/index.ts';
import { TOKENS } from './tokens.ts';
import { createLlmService } from '../services/llm.service.ts';
import { createPlannerService } from '../planner/planner.service.ts';
import { createExecutorService } from '../executor/executor.service.ts';
import { createAgentRuntimeFactory } from '../agents/agent.runtime.ts';
import { createAgentLifecycleManager } from '../agents/agent-lifecycle.ts';
import { createKnowledgeStore } from '../knowledge/knowledge-store.ts';
import { createHybridRetriever } from '../knowledge/hybrid-retriever.ts';
import { createHybridRetrieverPlugin } from '../knowledge/hybrid-retriever-plugin.ts';
import {
  createKnowledgeRanker,
  createWeightedRankingStrategy,
} from '../knowledge/knowledge-ranker.ts';
import { createKnowledgeRankerPlugin } from '../knowledge/knowledge-ranker-plugin.ts';
import type { Container } from './container/Container.ts';
import type { VectorStore } from './vectorstore/index.ts';
import type { PgClient } from './database/PgClient.ts';
import type { RedisClient } from './caching/RedisClient.ts';

// Plugins live next to the running code: src/plugins/ in development,
// dist/plugins/ in production. Dropping a *.plugin file there is the
// whole act of adding a plugin — no import list to maintain.
const DEFAULT_PLUGIN_DIRECTORY = fileURLToPath(
  new URL('../plugins/', import.meta.url),
);

export interface BootstrapOptions {
  /** Override the plugin directory (used by tests and embedders). */
  pluginDirectory?: string;
  /** Minimum log level (default 'info'; 'debug' surfaces event traffic). */
  logLevel?: LogLevel;
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

  // Observability exists BEFORE plugins install: the console sink and
  // the event bus bridge must already be attached when the first
  // plugin.installed event fires, or bootstrap itself is unobservable.
  // That is why the composition root constructs the default sink
  // directly instead of receiving it from a plugin — plugin-contributed
  // sinks join after installation, as ADDITIONAL destinations.
  const observability = new ObservabilityService({
    minLevel: options.logLevel ?? 'info',
  });
  observability.addSink(new ConsoleLogSink());
  observability.observeEventBus(eventBus);

  // Tracing exists BEFORE plugins install for the same reason as
  // observability: the console exporter and the event bus bridge must
  // already be attached when the first spans/events fire. Plugin-
  // contributed exporters join after installation, as ADDITIONAL
  // destinations — never replacing the console exporter.
  const tracing = new TraceManager();
  tracing.addExporter(new ConsoleSpanExporter());
  tracing.observeEventBus(eventBus);

  // Metrics exists BEFORE plugins install for the same reason. Unlike the
  // log/trace sinks, nothing dispatches to the console exporter until a
  // caller explicitly scrapes (metrics.export()) — the registry has no
  // "entry happened" moment to hook, only continuously-mutated state.
  const metrics = new MetricsRegistry();
  metrics.addExporter(new ConsoleMetricExporter());

  // Caching exists BEFORE plugins install for the same consistency reason
  // as the other observability primitives, even though nothing currently
  // needs a cache during installation — plugin-contributed caches
  // (cache-provider capability) register into it right after installs.
  const caching = new CacheRegistry();

  // Security exists BEFORE plugins install for the same consistency
  // reason. The API key source is wired straight from the already-loaded
  // `env` object (config/env.ts owns environment access — see
  // architecture.test.ts's ownership rule), and fetched once immediately
  // so the key is redaction-protected from this point on even if nothing
  // else ever calls getSecret('llm') directly.
  const security = new SecurityService();
  security.addSecretSource(new ApiKeyProvider({ llm: env.llm.apiKey }));
  security.getSecret('llm');

  // AAI-038: the gateway's authn/authz hub exists BEFORE plugins install
  // for the same consistency reason as every other cross-cutting module
  // above. Both credential sources are optional and independent — an
  // unconfigured deployment gets an AuthService whose isEnabled() is
  // false, so the HTTP layer's authorization middleware never enforces
  // anything and every route stays exactly as open as it was in AAI-037.
  // Configured API keys are also protected against accidental redaction
  // the same way the LLM key above is, since they're just as sensitive.
  const apiKeyStore =
    env.auth.apiKeys.length > 0 ? new ApiKeyStore(env.auth.apiKeys) : undefined;
  for (const definition of env.auth.apiKeys) {
    security.protect(definition.key);
  }
  const jwtService = env.auth.jwt.secret
    ? new JwtService({
        secret: env.auth.jwt.secret,
        ...(env.auth.jwt.issuer ? { issuer: env.auth.jwt.issuer } : {}),
      })
    : undefined;
  const auth = new AuthService({
    ...(apiKeyStore !== undefined ? { apiKeyStore } : {}),
    ...(jwtService !== undefined ? { jwtService } : {}),
  });
  if (env.auth.jwt.secret) {
    security.protect(env.auth.jwt.secret);
  }

  // Gateway rate limiting (AAI-038) — optional, independent of auth.
  const rateLimiter =
    env.rateLimit.windowMs > 0 && env.rateLimit.max > 0
      ? new RateLimiter({ windowMs: env.rateLimit.windowMs, max: env.rateLimit.max })
      : undefined;

  // Streaming exists BEFORE plugins install for the same consistency
  // reason, and connects to the shared event bus immediately: stream
  // lifecycle milestones (started/completed/failed/cancelled) publish
  // onto it, correlated by stream id, the same way plugin installs do.
  const streaming = new StreamManager();
  streaming.connectEventBus(eventBus);

  // Human-in-the-loop exists BEFORE plugins install for the same
  // consistency reason, and connects to the shared event bus immediately:
  // interaction requested/resolved/cancelled/timed-out events publish
  // onto it, correlated by interaction id.
  const interactions = new InteractionManager();
  interactions.connectEventBus(eventBus);

  // The workflow engine exists BEFORE plugins install for the same
  // consistency reason, and connects to the shared event bus immediately:
  // every run/step milestone publishes onto it, correlated by run id.
  const workflows = new WorkflowRuntime();
  workflows.connectEventBus(eventBus);

  // Checkpoint & recovery exists BEFORE plugins install for the same
  // consistency reason, and connects to the shared event bus immediately.
  // Defaults to an in-memory store; a plugin-contributed durable store
  // (checkpoint-store-provider capability) replaces it after installs —
  // the same single-swappable-backend idiom as the vector store.
  const checkpoints = new CheckpointManager();
  checkpoints.connectEventBus(eventBus);

  // AAI-036: optional persistent-storage backends. Constructed here —
  // BEFORE plugins install, same as every other cross-cutting module
  // above — and connected (their one necessarily-async setup step; see
  // PostgresVectorStore.connect()'s doc comment) before bootstrap ever
  // returns, so a caller resolving TOKENS.vectorStore or calling
  // checkpoints.checkpointAsync() immediately after bootstrap() never
  // races an unconnected store. Entirely optional: an unconfigured
  // deployment (no DATABASE_URL/REDIS_URL) gets exactly v2.0.0's
  // in-memory-only behavior, unchanged. `new Pool(...)` and
  // `createClient(...)` appear ONLY here — the same single-construction-
  // site rule as `new OpenAI(...)`, now enforced for Postgres/Redis too
  // (see core/architecture.test.ts).
  let vectorStore: VectorStore = new InMemoryVectorStore();
  let postgresPool: PgClient | undefined;
  let redisClient: RedisClient | undefined;
  let asyncCheckpointStore: PostgresCheckpointStore | undefined;
  let asyncKnowledgeStore: PostgresKnowledgeStore | undefined;
  let redisCache: RedisCache | undefined;

  if (env.postgres.url) {
    const pool = new Pool({ connectionString: env.postgres.url });
    postgresPool = pool;

    const pgVectorStore = new PostgresVectorStore(pool, {
      dimensions: env.postgres.vectorDimensions,
    });
    await pgVectorStore.connect();
    vectorStore = pgVectorStore;

    asyncCheckpointStore = new PostgresCheckpointStore(pool, 'postgres');
    await asyncCheckpointStore.connect();

    asyncKnowledgeStore = new PostgresKnowledgeStore(pool);
    await asyncKnowledgeStore.connect();
  }

  if (env.redis.url) {
    const rawClient = createClient({ url: env.redis.url });
    await rawClient.connect();

    // Adapter, not a direct structural assignment: the real client's
    // `set` overloads are far richer than RedisCache needs, and wrapping
    // explicitly here keeps RedisCache's own code decoupled from the
    // `redis` package entirely (it only ever sees RedisClient).
    redisClient = {
      get: (key) => rawClient.get(key),
      set: async (key, value, options) => {
        await rawClient.set(key, value, options?.ttlMs !== undefined ? { PX: options.ttlMs } : undefined);
      },
      del: (key) => rawClient.del(key),
      exists: async (key) => (await rawClient.exists(key)) > 0,
      keys: (pattern) => rawClient.keys(pattern),
    };

    redisCache = new RedisCache('redis', redisClient);
  }

  // Distributed agent execution (AAI-039). Off by default (see
  // config/env.ts's distributed.enabled) — everything below is skipped
  // entirely for a non-distributed deployment, which keeps TOKENS.
  // messageBus a plain MessageBus exactly as before this story.
  // Constructed eagerly, alongside the Redis cache client above, for the
  // same reason: the Redis-backed transport needs an awaited connect()
  // before services.build(), and `createClient(...)`/`new
  // WebSocketServer(...)`-style single-construction-site discipline
  // (core/architecture.test.ts) means any second Redis connection this
  // story needs must also live here.
  let distributedTransport: DistributedTransport | undefined;
  let distributedMessageBus: DistributedMessageBus | undefined;
  let workerRegistry: WorkerRegistry | undefined;
  let workerHeartbeatSender: WorkerHeartbeatSender | undefined;
  let heartbeatWatchdog: HeartbeatWatchdog | undefined;
  let distributedEventBridge: DistributedEventBridge | undefined;

  if (env.distributed.enabled) {
    if (env.distributed.transport === 'redis' && env.redis.url) {
      const publisher = createClient({ url: env.redis.url });
      await publisher.connect();
      // node-redis requires a DEDICATED connection for subscriber mode —
      // a client that has issued SUBSCRIBE cannot issue other commands.
      const subscriber = publisher.duplicate();
      await subscriber.connect();

      const pubSubClient: PubSubClient = {
        publish: async (channel, payload) => {
          await publisher.publish(channel, payload);
        },
        subscribe: (channel, onMessage) =>
          subscriber.subscribe(channel, (payload) => onMessage(payload)),
        unsubscribe: async (channel) => {
          await subscriber.unsubscribe(channel);
        },
      };

      distributedTransport = new RedisDistributedTransport(pubSubClient);
    } else {
      distributedTransport = new InMemoryDistributedTransport();
    }

    distributedMessageBus = new DistributedMessageBus(
      eventBus,
      distributedTransport,
      env.distributed.nodeId,
      {
        logger: observability.getLogger('distributed.message-bus'),
        metrics,
      },
    );

    workerRegistry = new WorkerRegistry({
      eventBus,
      transport: distributedTransport,
      nodeId: env.distributed.nodeId,
      workerType: env.distributed.workerType,
      logger: observability.getLogger('distributed.worker-registry'),
      metrics,
    });
    distributedMessageBus.connectWorkerRegistry(workerRegistry);

    // Sends this node's local workers' heartbeats — without it, every
    // locally-registered worker would silently go stale and eventually
    // be declared lost by its own node's HeartbeatWatchdog.
    workerHeartbeatSender = new WorkerHeartbeatSender({
      workerRegistry,
      transport: distributedTransport,
      eventBus,
      nodeId: env.distributed.nodeId,
      intervalMs: env.distributed.heartbeatIntervalMs,
      logger: observability.getLogger('distributed.heartbeat-sender'),
    });

    heartbeatWatchdog = new HeartbeatWatchdog({
      workerRegistry,
      eventBus,
      timeoutMs: env.distributed.heartbeatTimeoutMs,
      sweepIntervalMs: env.distributed.heartbeatIntervalMs,
      logger: observability.getLogger('distributed.heartbeat'),
      metrics,
    });

    distributedEventBridge = new DistributedEventBridge({
      eventBus,
      transport: distributedTransport,
      nodeId: env.distributed.nodeId,
      logger: observability.getLogger('distributed.event-bridge'),
    });
  }

  // Plugins install before the container builds, so services can receive
  // the loader (the aggregated tool catalog) as an ordinary dependency.
  const pluginRegistry = new PluginRegistry();
  const pluginLoader = new PluginLoader(
    pluginRegistry,
    eventBus,
    observability.getLogger('plugins'),
  );

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

  // Same lazy-accessor pattern for the shared vector store: the plugin
  // contribution and TOKENS.vectorStore are the same instance.
  await pluginLoader.install(
    createVectorStorePlugin(() => {
      if (!builtContainer) {
        throw new Error('The vector store is unavailable until bootstrap completes.');
      }
      return builtContainer.get(TOKENS.vectorStore);
    }),
  );

  // And for hybrid retrieval — contributed through the pre-existing
  // retriever-provider capability, because a hybrid retriever is just
  // a retriever.
  await pluginLoader.install(
    createHybridRetrieverPlugin(() => {
      if (!builtContainer) {
        throw new Error('Hybrid retrieval is unavailable until bootstrap completes.');
      }
      return builtContainer.get(TOKENS.hybridRetriever);
    }),
  );

  // And for the default ranking strategy — contributed through the new
  // ranking-strategy-provider capability under the name 'weighted'.
  await pluginLoader.install(
    createKnowledgeRankerPlugin(() => {
      if (!builtContainer) {
        throw new Error('Knowledge ranking is unavailable until bootstrap completes.');
      }
      return builtContainer.get(TOKENS.rankingStrategy);
    }),
  );

  // AAI-036: the optional Postgres/Redis-backed providers, installed as
  // built-in plugins for the SAME discoverability every other backend
  // gets — but WITHOUT the lazy-accessor indirection above, because
  // these instances are already fully constructed (and connected) by
  // this point; there is no later "which backend wins" decision left to
  // defer to builtContainer.
  if (asyncCheckpointStore) {
    const store = asyncCheckpointStore;
    await pluginLoader.install(createAsyncCheckpointStorePlugin(() => store));
  }
  if (asyncKnowledgeStore) {
    const store = asyncKnowledgeStore;
    await pluginLoader.install(createAsyncKnowledgeStorePlugin(() => store));
  }
  if (redisCache) {
    await pluginLoader.install(createRedisCachePlugin(redisCache));
  }

  // Plugin-contributed log sinks (log-sink-provider capability) join
  // the console sink as additional destinations for every entry.
  for (const sink of pluginLoader.getLogSinks()) {
    observability.addSink(sink);
  }

  // Plugin-contributed span exporters (span-exporter-provider capability)
  // join the console exporter as additional destinations for every span.
  for (const exporter of pluginLoader.getSpanExporters()) {
    tracing.addExporter(exporter);
  }

  // Plugin-contributed metric exporters (metric-exporter-provider
  // capability) join the console exporter as additional scrape targets.
  for (const exporter of pluginLoader.getMetricExporters()) {
    metrics.addExporter(exporter);
  }

  // Plugin-contributed caches (cache-provider capability) register under
  // their own names, alongside any caches created on demand via
  // caching.getOrCreate().
  for (const cache of pluginLoader.getCaches()) {
    caching.register(cache);
  }

  // Plugin-contributed ASYNC caches (async-cache-provider capability —
  // AAI-036, e.g. Redis) register into the same registry, under its
  // separate async catalog (CacheRegistry.registerAsync).
  for (const cache of pluginLoader.getAsyncCaches()) {
    caching.registerAsync(cache);
  }

  // Plugin-contributed secret sources (secret-provider capability) join
  // the API key provider as additional lookup sources for getSecret().
  for (const source of pluginLoader.getSecretSources()) {
    security.addSecretSource(source);
  }

  // Plugin-contributed stream observers (stream-observer-provider
  // capability) join as additional global watchers of every stream's events.
  for (const observer of pluginLoader.getStreamObservers()) {
    streaming.addObserver(observer);
  }

  // Plugin-contributed interaction observers (interaction-observer-provider
  // capability) join as additional global watchers of every interaction.
  for (const observer of pluginLoader.getInteractionObservers()) {
    interactions.addObserver(observer);
  }

  // Plugin-contributed workflow definitions (workflow-definition-provider
  // capability) become runnable through the workflow engine.
  for (const definition of pluginLoader.getWorkflowDefinitions()) {
    workflows.defineWorkflow(definition);
  }

  // A plugin-contributed checkpoint store (checkpoint-store-provider
  // capability) replaces the default in-memory one — same single-backend
  // swap as the vector store/embedding provider; first contribution wins.
  const [contributedCheckpointStore] = pluginLoader.getCheckpointStores();
  if (contributedCheckpointStore) {
    checkpoints.useStore(contributedCheckpointStore);
  }

  // Same swap for the ASYNC checkpoint backend (async-checkpoint-store-
  // provider capability — AAI-036, Postgres) — independent of the sync
  // swap above, since useStore()/useAsyncStore() govern separate backends.
  const [contributedAsyncCheckpointStore] = pluginLoader.getAsyncCheckpointStores();
  if (contributedAsyncCheckpointStore) {
    checkpoints.useAsyncStore(contributedAsyncCheckpointStore);
  }

  const services = new ServiceCollection();

  services.registerSingleton(TOKENS.eventBus, () => eventBus);

  // AAI-039: DistributedMessageBus when distributed mode is enabled,
  // plain MessageBus otherwise — the `distributedMessageBus` local
  // variable above already decided which. The MessageBus interface never
  // changes, so AgentRegistry/DelegationManager/SupervisorAgent below
  // need no changes to keep working: the same swappable-concrete-class
  // idiom as TOKENS.vectorStore (Postgres vs. in-memory).
  services.registerSingleton(TOKENS.messageBus, (container) =>
    distributedMessageBus ?? new MessageBus(container.get(TOKENS.eventBus)),
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
  // AAI-039: registered ONLY when distributed mode is enabled — resolve
  // these with container.resolve(), never container.get(), the same
  // optional-token discipline as the AAI-036/038 tokens below. Each
  // local `let` is captured into a narrowed const first for the same
  // reason postgresPool/redisClient are below: a closure over a `let`
  // does not stay narrowed to non-undefined by the time the factory runs.
  if (distributedTransport) {
    const transport = distributedTransport;
    services.registerSingleton(TOKENS.distributedTransport, () => transport);
  }
  if (workerRegistry) {
    const registry = workerRegistry;
    services.registerSingleton(TOKENS.workerRegistry, () => registry);
  }
  if (workerHeartbeatSender) {
    const sender = workerHeartbeatSender;
    services.registerSingleton(TOKENS.workerHeartbeatSender, () => sender);
  }
  if (heartbeatWatchdog) {
    const watchdog = heartbeatWatchdog;
    services.registerSingleton(TOKENS.heartbeatWatchdog, () => watchdog);
  }
  if (distributedEventBridge) {
    const bridge = distributedEventBridge;
    services.registerSingleton(TOKENS.distributedEventBridge, () => bridge);
  }
  if (env.distributed.enabled && distributedTransport) {
    const transport = distributedTransport;
    services.registerSingleton(TOKENS.remoteTaskBridge, (container) =>
      new RemoteTaskBridge({
        transport,
        nodeId: env.distributed.nodeId,
        delegationManager: container.get(TOKENS.delegationManager),
        logger: observability.getLogger('distributed.task-bridge'),
      }),
    );
  }
  if (env.distributed.enabled && workerRegistry) {
    const registry = workerRegistry;
    services.registerSingleton(TOKENS.distributedSupervisor, (container) =>
      new DistributedSupervisor({
        delegationManager: container.get(TOKENS.delegationManager),
        eventBus: container.get(TOKENS.eventBus),
        workerRegistry: registry,
        agentRegistry: container.get(TOKENS.agentRegistry),
        maxRetries: env.distributed.maxRetries,
        logger: observability.getLogger('distributed.supervisor'),
        tracer: tracing.getTracer('distributed.supervisor'),
        metrics,
      }),
    );
  }

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

  // AAI-036: PostgresVectorStore when configured, InMemoryVectorStore
  // otherwise — the `vectorStore` local variable already decided which
  // above. The VectorStore interface never changes, so nothing
  // downstream (hybridRetriever, the vector-store plugin) needs to know
  // or care which backend it got.
  services.registerSingleton(TOKENS.vectorStore, () => vectorStore);

  services.registerSingleton(TOKENS.hybridRetriever, (container) =>
    createHybridRetriever({
      knowledgeStore: container.get(TOKENS.knowledgeStore),
      embeddingService: container.get(TOKENS.embeddingService),
      vectorStore: container.get(TOKENS.vectorStore),
    }),
  );

  services.registerSingleton(TOKENS.rankingStrategy, () =>
    createWeightedRankingStrategy(),
  );

  services.registerSingleton(TOKENS.knowledgeRanker, (container) =>
    createKnowledgeRanker(container.get(TOKENS.rankingStrategy)),
  );

  services.registerSingleton(TOKENS.observability, () => observability);
  services.registerSingleton(TOKENS.tracing, () => tracing);
  services.registerSingleton(TOKENS.metrics, () => metrics);
  services.registerSingleton(TOKENS.caching, () => caching);
  services.registerSingleton(TOKENS.security, () => security);
  services.registerSingleton(TOKENS.auth, () => auth);
  if (rateLimiter) {
    const limiter = rateLimiter;
    services.registerSingleton(TOKENS.rateLimiter, () => limiter);
  }
  services.registerSingleton(TOKENS.streaming, () => streaming);
  services.registerSingleton(TOKENS.interactions, () => interactions);
  services.registerSingleton(TOKENS.workflows, () => workflows);
  services.registerSingleton(TOKENS.checkpoints, () => checkpoints);

  // AAI-036: registered ONLY when configured — resolve these with
  // container.resolve(), which returns undefined instead of throwing for
  // an unregistered token (see core/container/Container.ts), never
  // container.get(). Each is captured into a narrowed const first: a
  // closure over the outer `let` would widen back to `T | undefined`
  // even inside this `if`, since TypeScript can't prove the `let` stays
  // narrowed by the time the factory actually runs.
  if (postgresPool) {
    const pool = postgresPool;
    services.registerSingleton(TOKENS.postgresPool, () => pool);
  }
  if (redisClient) {
    const client = redisClient;
    services.registerSingleton(TOKENS.redisClient, () => client);
  }
  if (asyncKnowledgeStore) {
    const store = asyncKnowledgeStore;
    services.registerSingleton(TOKENS.asyncKnowledgeStore, () => store);
  }

  // ServiceProvider plugins contribute services last, into the same
  // collection — duplicate protection guards them against core tokens
  // (and each other) before the container is frozen by build().
  pluginLoader.registerServices(services);

  builtContainer = services.build();

  // AAI-039: post-build distributed wiring. WorkerRegistry/
  // DistributedMessageBus are connected to AgentRegistry/
  // RemoteTaskBridge here — AFTER the container exists — specifically to
  // avoid a MessageBus -> WorkerRegistry -> AgentRegistry -> MessageBus
  // construction cycle (see WorkerRegistry's class doc comment); the same
  // reasoning CheckpointManager.connectEventBus() follows above, just
  // deferred one step further, to after container.build() rather than
  // merely after its own construction.
  if (env.distributed.enabled && workerRegistry && distributedMessageBus) {
    workerRegistry.connectAgentRegistry(builtContainer.get(TOKENS.agentRegistry));

    const remoteTaskBridge = builtContainer.resolve(TOKENS.remoteTaskBridge);
    if (remoteTaskBridge) {
      distributedMessageBus.connectRemoteTaskBridge(remoteTaskBridge);
    }

    workerHeartbeatSender?.start();
    heartbeatWatchdog?.start();
    distributedEventBridge?.start();
  }

  return builtContainer;
}
