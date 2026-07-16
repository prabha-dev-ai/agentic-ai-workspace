import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { parseApiKeyDefinitions } from '../core/auth/ApiKeyStore.ts';

dotenv.config();

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',

  port: Number(process.env.PORT) || 3000,

  llm: {
    provider: process.env.LLM_PROVIDER || 'openrouter',
    apiKey: process.env.LLM_API_KEY || '',
    baseUrl: process.env.LLM_BASE_URL || '',
    model: process.env.LLM_MODEL || '',
  },

  // Optional persistent-storage backends (AAI-036). Empty string means
  // "not configured" — bootstrap falls back to the in-memory defaults,
  // so no deployment is forced to run Postgres/Redis just to start.
  postgres: {
    url: process.env.DATABASE_URL || '',
    /** Column width for the pgvector-backed vector store. Must match the
     *  embedding model in use — see EmbeddingModel.ts. */
    vectorDimensions: Number(process.env.PG_VECTOR_DIMENSIONS) || 1536,
  },

  redis: {
    url: process.env.REDIS_URL || '',
  },

  // Gateway authentication/authorization (AAI-038). Both credential
  // sources are entirely optional and independent of each other — leaving
  // both unset gives you exactly AAI-037's behavior (every route open),
  // since AuthService.isEnabled() is false and the authorization
  // middleware becomes a no-op. See core/auth/ApiKeyStore.ts for the
  // API_KEYS format.
  auth: {
    apiKeys: parseApiKeyDefinitions(process.env.API_KEYS || ''),
    jwt: {
      secret: process.env.JWT_SECRET || '',
      issuer: process.env.JWT_ISSUER || '',
    },
  },

  // Gateway rate limiting (AAI-038). Optional — unset (or either value
  // non-positive) disables it entirely, same reasoning as the auth block
  // above.
  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 0,
    max: Number(process.env.RATE_LIMIT_MAX) || 0,
  },

  // Distributed agent execution (AAI-039). Disabled by default — an
  // unconfigured deployment keeps exactly today's single-process
  // behavior (TOKENS.messageBus stays a plain MessageBus; no worker
  // registry, heartbeat, or event-bridge intervals ever start). See
  // core/distributed/index.ts.
  distributed: {
    enabled: process.env.DISTRIBUTED_ENABLED === 'true',
    /** This process's node identity, stamped on every worker
     *  announcement/heartbeat/forwarded message. Random per process when
     *  unset, so a local multi-instance dev setup does not need manual
     *  configuration to get distinct node ids. */
    nodeId: process.env.NODE_ID || randomUUID(),
    /** Registry agent type treated as a routing candidate — must match
     *  whatever SupervisorAgent/DistributedSupervisor is configured with. */
    workerType: process.env.DISTRIBUTED_WORKER_TYPE || 'worker',
    heartbeatIntervalMs: Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS) || 5000,
    heartbeatTimeoutMs: Number(process.env.WORKER_HEARTBEAT_TIMEOUT_MS) || 15000,
    /** How many times DistributedSupervisor re-delegates a failed task to
     *  a different worker before giving up. 0 disables retry. */
    maxRetries: Number(process.env.DISTRIBUTED_MAX_RETRIES) || 0,
    /** "memory" (default, zero-dependency, single-process reference
     *  transport) or "redis" (real cross-process delivery — requires
     *  redis.url above to also be set). */
    transport: (process.env.DISTRIBUTED_TRANSPORT || 'memory') as 'memory' | 'redis',
  },
};